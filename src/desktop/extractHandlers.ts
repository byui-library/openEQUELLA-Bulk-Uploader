// src/desktop/extractHandlers.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { dialog, shell } from 'electron';
import { extractDefinition, extractItemNamePath, parseSchemaPaths } from '../core/schema.js';
import { extractFolder, listFolder } from '../core/extract/extract.js';
import { readDocument } from '../core/extract/readers/index.js';
import { findLabels } from '../core/extract/labels.js';
import { evidenceFrom, spreadAcrossTypes, SAMPLE_DOCS } from '../core/extract/evidence.js';
import { buildRow } from '../core/extract/rows.js';
import { writeCsv } from '../core/extract/csv.js';
import { loadProfile, saveProfile, parseProfile } from '../core/extract/profile.js';
import { starterProfile } from '../core/extract/suggest.js';
import { listTemplates, loadTemplate } from '../core/extract/templates.js';
import type { DocumentData, ExtractedRow, Profile } from '../core/extract/types.js';
import { CHANNELS, type ExtractScan, type ExtractRunReport } from './ipc.js';

const PREVIEW_ROWS = 5;

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
  /** Directory of shipped template profiles. Resolved by the caller, same as schemaFile. */
  templatesDir: string;
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

    // Shared with the CLI's --init-profile. It used to live here, which meant
    // a CLI-built profile had no description sources and no table mappings at
    // all -- every fix for descriptions reached the GUI only.
    const evidence = evidenceFrom(docs.map((d) => d.doc));

    return {
      ...evidence,
      supported,
      skipped,
      // Built from what the scan actually found, not from filenames alone.
      // Without the evidence, a table heading of "Job Description" went
      // unmapped and the description column came out empty on every row.
      starter: starterProfile(supported, {
        ...evidence,
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

  // Read here rather than in the renderer for the usual reason: this reaches
  // `node:fs`, and a `node:` import anywhere the renderer can reach blanks the
  // window with nothing on the terminal (tests/desktop/rendererPurity.test.ts).
  ipcMain.handle(CHANNELS.schemaNamePath, async (): Promise<string | null> => {
    return extractItemNamePath(await readFile(options.schemaFile, 'utf8'));
  });

  ipcMain.handle(CHANNELS.listTemplates, () => listTemplates(options.templatesDir));
  ipcMain.handle(CHANNELS.loadTemplate, (_e, id: string) => loadTemplate(id, options.templatesDir));

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
