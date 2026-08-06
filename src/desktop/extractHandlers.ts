// src/desktop/extractHandlers.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { dialog, shell } from 'electron';
import { extractDefinition, parseSchemaPaths } from '../core/schema.js';
import { extractFolder, listFolder } from '../core/extract/extract.js';
import { readDocument } from '../core/extract/readers/index.js';
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
  schemaPathsCache = null;
}

/**
 * Which files to open, spread across the file types present.
 *
 * Taking simply the first N is wrong for a mixed folder: sorted alphabetically,
 * a folder of twelve PDFs and eighteen Word documents gives five PDFs and not
 * one `.docx`, so nothing would learn that those Word files keep their metadata
 * in a table. The operator then sees no table columns offered at all.
 */
function spreadAcrossTypes(filenames: string[], limit: number): string[] {
  const byExtension = new Map<string, string[]>();
  for (const name of filenames) {
    const extension = (name.split('.').pop() ?? '').toLowerCase();
    (byExtension.get(extension) ?? byExtension.set(extension, []).get(extension)!).push(name);
  }

  const chosen: string[] = [];
  const queues = [...byExtension.values()];
  // Round-robin, so each type is represented before any type gets a second.
  for (let i = 0; chosen.length < limit && queues.some((q) => q.length > i); i++) {
    for (const queue of queues) {
      if (chosen.length >= limit) break;
      const next = queue[i];
      if (next !== undefined) chosen.push(next);
    }
  }
  return chosen;
}

/**
 * The documents behind the preview, read once per folder. Listing happens
 * INSIDE the cache miss: it used to run at both call sites before this was
 * invoked, so every column edit walked the directory and discarded the result.
 */
async function sample(dir: string): Promise<CacheEntry> {
  if (cache?.dir === dir) return cache;
  const { supported } = await listFolder(dir);
  const docs: { filename: string; doc: DocumentData }[] = [];
  for (const filename of spreadAcrossTypes(supported, Math.max(PREVIEW_ROWS, SAMPLE_DOCS))) {
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

/**
 * The schema's leaf paths, parsed once per process.
 *
 * The file is a bundled resource that never changes at runtime, and it is now
 * read on every folder scan as well as by the schemaPaths channel.
 */
let schemaPathsCache: Promise<Set<string>> | null = null;
function schemaPathsOnce(schemaFile: string): Promise<Set<string>> {
  schemaPathsCache ??= readFile(schemaFile, 'utf8').then((xml) =>
    parseSchemaPaths(extractDefinition(xml)),
  );
  return schemaPathsCache;
}

export interface ExtractHandlerOptions {
  /** Path to the schema export. Resolved by the caller, which knows if the app is packaged. */
  schemaFile: string;
}

export function registerExtractHandlers(ipcMain: IpcMain, options: ExtractHandlerOptions): void {
  ipcMain.handle(CHANNELS.extractScan, async (_e, dir: string): Promise<ExtractScan> => {
    // listFolder is core's own, shared with extractFolder. This handler used to
    // reimplement it, with a shorter skip reason that omitted the extension --
    // so a skipped file was described one way here and another way in the run
    // that followed.
    const { supported, skipped } = await listFolder(dir);

    cache = null;
    const { docs } = await sample(dir);

    const labels = new Set<string>();
    const properties = new Set<string>();
    const tableColumns = new Set<string>();
    for (const { doc } of docs) {
      for (const label of findLabels(doc.text).keys()) labels.add(label);
      for (const key of DOCUMENT_PROPERTIES) if (doc.properties[key] !== undefined) properties.add(key);
      // Only headers that have a value under them. A header with an empty cell
      // in every sampled document would offer a mapping that is always blank.
      for (const table of doc.tables) {
        table.headers.forEach((header, i) => {
          if (header.trim() !== '' && (table.rows[0]?.[i] ?? '').trim() !== '') {
            tableColumns.add(header.trim());
          }
        });
      }
    }

    return {
      supported,
      skipped,
      labels: [...labels].sort(),
      properties: [...properties],
      tableColumns: [...tableColumns].sort(),
      // Built from what the scan actually found, not from filenames alone.
      // Without the evidence, a table heading of "Job Description" went
      // unmapped and the description column came out empty on every row.
      starter: starterProfile(supported, {
        labels: [...labels],
        properties: [...properties],
        tableColumns: [...tableColumns],
        schemaPaths: await schemaPathsOnce(options.schemaFile),
      }),
    };
  });

  ipcMain.handle(
    CHANNELS.extractPreview,
    async (_e, args: { dir: string; profile: Profile }): Promise<ExtractedRow[]> => {
      const { docs } = await sample(args.dir);
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
    return [...(await schemaPathsOnce(options.schemaFile))].sort();
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
