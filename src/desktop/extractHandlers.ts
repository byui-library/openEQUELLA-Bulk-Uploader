// src/desktop/extractHandlers.ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { dialog, shell } from 'electron';
import { extractDefinition, parseSchemaPaths } from '../core/schema.js';
import { extractFolder } from '../core/extract/extract.js';
import { readDocument, isSupported } from '../core/extract/readers/index.js';
import { findLabels } from '../core/extract/labels.js';
import { buildRow } from '../core/extract/rows.js';
import { writeCsv } from '../core/extract/csv.js';
import { loadProfile, saveProfile, parseProfile } from '../core/extract/profile.js';
import { starterProfile } from '../core/extract/suggest.js';
import { DOCUMENT_PROPERTIES, type DocumentData, type ExtractedRow, type Profile } from '../core/extract/types.js';
import { CHANNELS, type ExtractScan, type ExtractRunReport } from './ipc.js';

const PREVIEW_ROWS = 5;
/** How many documents to open when scanning, to learn what can be mapped from. */
const SAMPLE_DOCS = 5;

interface CacheEntry {
  dir: string;
  docs: { filename: string; doc: DocumentData }[];
}
let cache: CacheEntry | null = null;

/** Exported for tests. The cache is a preview accelerator, never a source of truth. */
export function __resetExtractCache(): void {
  cache = null;
}

async function sample(dir: string, filenames: string[]): Promise<CacheEntry> {
  if (cache?.dir === dir) return cache;
  const docs: { filename: string; doc: DocumentData }[] = [];
  for (const filename of filenames.slice(0, Math.max(PREVIEW_ROWS, SAMPLE_DOCS))) {
    try {
      docs.push({ filename, doc: await readDocument(join(dir, filename)) });
    } catch {
      // A file that will not open is reported by extractScan's skipped list;
      // it must not stop the sample, or one bad file blanks the whole preview.
    }
  }
  cache = { dir, docs };
  return cache;
}

export interface ExtractHandlerOptions {
  /** Path to the schema export. Resolved by the caller, which knows if the app is packaged. */
  schemaFile: string;
}

export function registerExtractHandlers(ipcMain: IpcMain, options: ExtractHandlerOptions): void {
  ipcMain.handle(CHANNELS.extractScan, async (_e, dir: string): Promise<ExtractScan> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    const supported = files.filter(isSupported);

    const skipped = files
      .filter((f) => !isSupported(f))
      .map((file) => ({
        file,
        reason: file.toLowerCase().endsWith('.doc')
          ? 'Word 2003 and earlier (.doc) cannot be read -- save as .docx first'
          : 'unsupported file type',
      }));

    cache = null;
    const { docs } = await sample(dir, supported);

    const labels = new Set<string>();
    const properties = new Set<string>();
    for (const { doc } of docs) {
      for (const label of findLabels(doc.text).keys()) labels.add(label);
      for (const key of DOCUMENT_PROPERTIES) if (doc.properties[key] !== undefined) properties.add(key);
    }

    return {
      supported,
      skipped,
      labels: [...labels].sort(),
      properties: [...properties],
      starter: starterProfile(supported),
    };
  });

  ipcMain.handle(
    CHANNELS.extractPreview,
    async (_e, args: { dir: string; profile: Profile }): Promise<ExtractedRow[]> => {
      const entries = await readdir(args.dir, { withFileTypes: true });
      const supported = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter(isSupported)
        .sort((a, b) => a.localeCompare(b));

      const { docs } = await sample(args.dir, supported);
      return docs
        .slice(0, PREVIEW_ROWS)
        .map(({ filename, doc }) => buildRow(args.profile, filename, doc));
    },
  );

  ipcMain.handle(
    CHANNELS.extractRun,
    async (_e, args: { dir: string; profile: Profile; outPath: string }): Promise<ExtractRunReport> => {
      // Deliberately does NOT use the preview cache: the real run reads every
      // file fresh, so what is written can never be stale relative to disk.
      const result = await extractFolder(args.dir, args.profile);
      await writeCsv(args.outPath, args.profile, result.rows);
      return {
        outPath: args.outPath,
        written: result.rows.length,
        flagged: result.rows.filter((r) => r.notes.length > 0).length,
      };
    },
  );

  ipcMain.handle(CHANNELS.schemaPaths, async (): Promise<string[]> => {
    const xml = await readFile(options.schemaFile, 'utf8');
    return [...parseSchemaPaths(extractDefinition(xml))].sort();
  });

  ipcMain.handle(CHANNELS.openProfile, async (): Promise<{ path: string; profile: Profile } | null> => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Extraction profile', extensions: ['json'] }],
    });
    const path = r.canceled ? null : (r.filePaths[0] ?? null);
    if (path === null) return null;
    return { path, profile: await loadProfile(path) };
  });

  ipcMain.handle(CHANNELS.saveProfileAs, async (_e, profile: Profile): Promise<string | null> => {
    const r = await dialog.showSaveDialog({
      defaultPath: 'extraction.profile.json',
      filters: [{ name: 'Extraction profile', extensions: ['json'] }],
    });
    if (r.canceled || r.filePath === undefined) return null;
    // Re-validated on the way out so a profile assembled in the UI cannot be
    // saved in a state the loader would later refuse.
    await saveProfile(r.filePath, parseProfile(profile));
    return r.filePath;
  });

  ipcMain.handle(CHANNELS.chooseCsvPath, async (): Promise<string | null> => {
    const r = await dialog.showSaveDialog({
      defaultPath: 'extracted.csv',
      filters: [{ name: 'Spreadsheet', extensions: ['csv'] }],
    });
    return r.canceled || r.filePath === undefined ? null : r.filePath;
  });

  ipcMain.handle(CHANNELS.openPath, async (_e, path: string): Promise<void> => {
    // showItemInFolder rather than openPath: the operator wants the folder
    // with the file selected, not Excel launching behind the app window.
    shell.showItemInFolder(path);
  });
}
