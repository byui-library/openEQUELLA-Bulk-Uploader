// src/desktop/extractHandlers.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { dialog, shell } from 'electron';
import {
  extractDefinition,
  extractItemDescriptionPath,
  extractItemNamePath,
  parseSchemaPaths,
} from '../core/schema.js';
import { extractFolder, listFolder } from '../core/extract/extract.js';
import { readDocument } from '../core/extract/readers/index.js';
import { findLabels } from '../core/extract/labels.js';
import { evidenceFrom, spreadAcrossTypes, SAMPLE_DOCS } from '../core/extract/evidence.js';
import { buildRow } from '../core/extract/rows.js';
import { writeCsv } from '../core/extract/csv.js';
import { loadProfile, saveProfile, parseProfile } from '../core/extract/profile.js';
import { starterProfile, type StarterSchema } from '../core/extract/suggest.js';
import { listTemplates, loadTemplate } from '../core/extract/templates.js';
import type { DocumentData, ExtractedRow, Profile } from '../core/extract/types.js';
import { modelColumns } from '../core/ai/eligible.js';
import { noteMissingModel, type FillTarget } from '../core/ai/fill.js';
import { runModelPass, type ModelPassSettings } from '../core/ai/pass.js';
import { countModelWritten, countNeedingReview } from '../core/ai/review.js';
import type { SchemaInfo } from '../core/discovery.js';
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
  bundledSchemaCache = null;
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
 * The bundled export's leaf paths AND the paths it declares for an item's name
 * and description, parsed once per process.
 *
 * The file is a bundled resource that never changes at runtime, and it is read
 * on every folder scan as well as by the schemaPaths and schemaNamePath
 * channels. All three read it through here so a fallback answer can never
 * disagree with itself, and so the starter profile's title and description
 * columns come from what this export declares rather than from BYU-Idaho's
 * paths written into the code.
 */
let bundledSchemaCache: Promise<StarterSchema> | null = null;
function bundledSchemaOnce(schemaFile: string): Promise<StarterSchema> {
  bundledSchemaCache ??= readFile(schemaFile, 'utf8').then((xml) => ({
    titleHeader: extractItemNamePath(xml),
    descriptionHeader: extractItemDescriptionPath(xml),
    paths: parseSchemaPaths(extractDefinition(xml)),
  }));
  return bundledSchemaCache;
}

export interface ExtractHandlerOptions {
  /** Path to the schema export. Resolved by the caller, which knows if the app is packaged. */
  schemaFile: string;
  /** Directory of shipped template profiles. Resolved by the caller, same as schemaFile. */
  templatesDir: string;
  /**
   * The schema fetched from an instance and cached on disk, or null when there
   * is none for it. Injected rather than read here so this module stays free of
   * the secret store: resolving an instance id to its base url and schema uuid
   * is the caller's business (handlers.ts#cachedSchema).
   *
   * WHY THE CACHE EXISTS AT ALL: `src/core/extract/` never touches the network,
   * which is what lets an operator build a spreadsheet without signing in to
   * anything. The schema it validates columns against now comes from the API.
   * The cache is what reconciles those two facts -- whoever DID sign in leaves
   * the schema on disk, and extraction reads it later, offline.
   *
   * Optional, and null is ordinary. Absent or null falls back to `schemaFile`,
   * the export bundled with the app. Extraction MUST still run without a
   * cache: refusing would trade a real capability for a check the operator
   * never asked for.
   */
  cachedSchema?: (instanceId: string) => Promise<SchemaInfo | null>;
  /**
   * The model endpoint stored for an instance, or null when there is none.
   *
   * INJECTED FOR THE SAME REASON `cachedSchema` IS: this module stays free of
   * the secret store, and resolving an instance id to a decrypted credential is
   * the caller's business (handlers.ts). It also keeps the API KEY IN THE MAIN
   * PROCESS -- the renderer is given `ModelChoice` (ipc.ts), which mirrors these
   * settings minus the key, and the key must not cross that boundary to be used.
   *
   * ABSENT OR NULL IS THE ORDINARY CASE and means the feature does not exist for
   * this run: no request is made, and every column that asked for a model says
   * so. That is the zero-prerequisite promise, and it is what lets this tool be
   * adopted without a data review.
   */
  modelFor?: (instanceId: string) => Promise<ModelPassSettings | null>;
  /**
   * `fetch` for the model pass. Injected so a test can prove that an
   * unconfigured institution sends nothing anywhere -- a promise nothing can
   * watch is not a promise.
   */
  fetchImpl?: typeof fetch;
}

export function registerExtractHandlers(ipcMain: IpcMain, options: ExtractHandlerOptions): void {
  ipcMain.handle(CHANNELS.extractScan, async (_e, dir: string, instanceId?: string): Promise<ExtractScan> => {
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
      // Against the SAME schema the Add-column picker uses -- the site's own
      // when it has been cached, the bundled export otherwise. Two different
      // schemas here would have the starter propose columns the picker then
      // reports as invalid.
      starter: starterProfile(
        supported,
        (await cachedFor(instanceId)) ?? (await bundledSchemaOnce(options.schemaFile)),
        evidence,
      ),
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
    async (
      _e,
      args: { dir: string; profile: Profile; outPath: string; instanceId?: string },
    ): Promise<ExtractRunReport> => {
      // THE MODEL PASS BELONGS HERE AND NOT IN extractPreview. The preview
      // re-renders on every column edit, so running it there is a paid call per
      // keystroke. This is the one place a document is read for real.
      const wantsModel = modelColumns(args.profile).length > 0;
      const settings = wantsModel ? await modelSettingsFor(args.instanceId) : null;

      // Documents are kept only when something is going to read them: holding
      // four hundred of them for a run that will send none is memory spent on
      // nothing.
      const targets: FillTarget[] = [];
      const collect =
        settings === null ? {} : { onRow: (row: ExtractedRow, doc: DocumentData) => { targets.push({ row, doc }); } };

      // Deliberately does NOT use the preview cache: the real run reads every
      // file fresh, so what is written can never be stale relative to disk.
      const result = await extractFolder(args.dir, args.profile, collect);

      if (wantsModel) {
        if (settings === null) {
          // A column asked for a model and there is none. Said per cell: a
          // silently empty cell cannot be told from a document that had nothing
          // to say, which is a thing that could not run reported as if it had.
          noteMissingModel(result.rows, args.profile);
        } else {
          await runModelPass(targets, args.profile, settings, options.fetchImpl);
        }
      }

      await writeCsv(args.outPath, args.profile, result.rows);
      return {
        outPath: args.outPath,
        written: result.rows.length,
        // NOT `notes.length > 0`. Every model write carries a note, so that
        // would report 400 of 400 and bury the batch's one genuine failure --
        // the loss `flagIfEmpty`'s docblock exists to prevent. Subtracted by
        // identity against `aiWritten`; see core/ai/review.ts.
        flagged: countNeedingReview(result.rows),
        aiWritten: countModelWritten(result.rows),
      };
    },
  );

  /**
   * The stored endpoint for this run, or null for "no model".
   *
   * NEVER THROWS, and an unreadable store is "no model" rather than a stopped
   * extract. Extraction works offline and without any of this; refusing to build
   * a spreadsheet because a settings file would not decrypt would break the half
   * of the tool that has no prerequisites, over a feature the operator may never
   * have configured. `controller.ts#approveModelRun` reaches the same conclusion
   * on the renderer side, so the confirmation and the run agree about what an
   * unreadable store means.
   */
  async function modelSettingsFor(instanceId?: string): Promise<ModelPassSettings | null> {
    if (!instanceId || !options.modelFor) return null;
    try {
      return await options.modelFor(instanceId);
    } catch {
      return null;
    }
  }

  ipcMain.handle(CHANNELS.schemaPaths, async (_e, instanceId?: string): Promise<string[]> => {
    const cached = await cachedFor(instanceId);
    if (cached) return [...cached.paths].sort();
    return [...(await bundledSchemaOnce(options.schemaFile)).paths].sort();
  });

  // Read here rather than in the renderer for the usual reason: this reaches
  // `node:fs`, and a `node:` import anywhere the renderer can reach blanks the
  // window with nothing on the terminal (tests/desktop/rendererPurity.test.ts).
  ipcMain.handle(CHANNELS.schemaNamePath, async (_e, instanceId?: string): Promise<string | null> => {
    const cached = await cachedFor(instanceId);
    // `titleHeader`, not `namePath`: this answers in spreadsheet-header form
    // (`MWDL/title`), which is what `extractItemNamePath` returns from the
    // bundled export below -- it strips the leading slash. The two sources
    // have to be interchangeable or the Add-column picker's first section
    // silently stops matching any column.
    if (cached) return cached.titleHeader;
    return (await bundledSchemaOnce(options.schemaFile)).titleHeader;
  });

  /**
   * The instance's own cached schema, or null to fall back to the bundled
   * export. Never throws: a resolver that fails for any reason is "no cache",
   * which is the same answer as an operator who has never signed in, and the
   * extract flow has to work for them.
   */
  async function cachedFor(instanceId?: string): Promise<SchemaInfo | null> {
    if (!instanceId || !options.cachedSchema) return null;
    try {
      return await options.cachedSchema(instanceId);
    } catch {
      return null;
    }
  }

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
