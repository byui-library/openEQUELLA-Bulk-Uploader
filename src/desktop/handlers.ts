import { app, dialog, safeStorage, type BrowserWindow, type IpcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, copyFile } from 'node:fs/promises';
import {
  CHANNELS,
  type ColumnReport,
  type OeqApi,
  type PlanReport,
  type RunReport,
  type SchemaSummary,
} from './ipc.js';
import { SecretStore, EncryptedTokenStore, type Instance } from './secrets.js';
import { SchemaCache } from '../core/schemaCache.js';
import type { SchemaInfo } from '../core/discovery.js';
import { buildAuth, buildCodeAuth, buildClient, buildConfig, requireInstance } from './session.js';
import { readSheet } from '../core/sheet.js';
import {
  extractDefinition,
  extractItemNamePath,
  parseSchemaPaths,
  validateHeaders,
  isAnnotationHeader,
} from '../core/schema.js';
import { buildManifest, preflightDuplicates, markSkipped } from '../core/plan.js';
import { findDuplicates } from '../core/duplicates.js';
import { saveManifest, loadManifest } from '../core/state.js';
import { runManifest } from '../core/runner.js';
import { signInInteractive } from './signin.js';
import type { Sheet } from '../core/types.js';
import { OeqError } from '../core/errors.js';
import { registerExtractHandlers } from './extractHandlers.js';

const userData = () => app.getPath('userData');

const cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s: string) => safeStorage.encryptString(s),
  decrypt: (b: Buffer) => safeStorage.decryptString(b),
};

const secrets = () => new SecretStore(join(userData(), 'settings.enc'), cipher);
const tokens = () => new EncryptedTokenStore(join(userData(), 'token.enc'), cipher);

/**
 * Fetched schemas, on disk, so extraction can validate its columns offline.
 *
 * NOT encrypted, unlike the two stores above, and deliberately not: a schema
 * is a public description of a collection's fields, holds no credential and
 * nothing personal, and `SchemaCache` is a plain-JSON cache that any of its
 * files being unreadable degrades to "no cache" rather than to an error.
 */
const schemas = () => new SchemaCache(join(userData(), 'schema-cache'));

/** A fetched schema in the shape that crosses IPC -- `paths` as an array, not a Set. */
function toSummary(schema: SchemaInfo): SchemaSummary {
  return {
    uuid: schema.uuid,
    namePath: schema.namePath,
    titleHeader: schema.titleHeader,
    paths: [...schema.paths].sort(),
  };
}

/**
 * Read one schema and leave it in the cache on the way past.
 *
 * THE WRITE IS THE POINT, as much as the answer is. `src/core/extract/` never
 * touches the network -- which is what lets an operator build a spreadsheet
 * without signing in to anything -- so this is the only way a schema fetched
 * here reaches the column validation that happens there.
 *
 * A CACHE WRITE THAT FAILS DOES NOT FAIL THE FETCH. The operator asked to see
 * a schema, not to populate a cache; a full or read-only disk would otherwise
 * turn "here are your collection's fields" into an error dialog, and the only
 * thing actually lost is a later offline validation that degrades to the
 * bundled export anyway.
 *
 * Taken as parameters rather than built here so it can be exercised without an
 * Electron process, a live instance, or an https address -- `saveInstance`
 * refuses anything else, which puts the real handler's path out of reach of a
 * loopback mock server.
 */
export async function fetchAndCacheSchema(
  client: { getSchema(uuid: string): Promise<SchemaInfo> },
  cache: { save(instanceUrl: string, schema: SchemaInfo): Promise<void> },
  instanceUrl: string,
  schemaUuid: string,
): Promise<SchemaSummary> {
  const schema = await client.getSchema(schemaUuid);
  try {
    await cache.save(instanceUrl, schema);
  } catch {
    // See above: the answer is still good.
  }
  return toSummary(schema);
}

/**
 * The cached schema for one instance, or null when there is none.
 *
 * Null for every ordinary reason: no instance selected, a site whose schema
 * has never been fetched, a collection that names no schema, an unreadable or
 * damaged cache file. Every one of those means "validate against the bundled
 * export instead" -- never "refuse to extract". See `SchemaCache`'s own doc
 * comment, which makes the same promise about its reads.
 */
async function cachedSchema(instanceId: string): Promise<SchemaInfo | null> {
  if (!instanceId) return null;
  const inst = await secrets().loadInstance(instanceId);
  if (!inst || inst.schemaUuid === '') return null;
  return schemas().load(inst.baseUrl, inst.schemaUuid);
}

/**
 * The exact wording an operator sees when the instance they've selected has
 * no saved credentials. Names the instance -- with credentials per instance
 * (see secrets.ts), a bare "no credentials" would be actively confusing:
 * which one? Takes the label rather than the id because the id is the site's
 * address, and the operator picked their site from a dropdown of their own
 * names for them.
 */
export function missingCredentialsMessage(label: string): string {
  // Says "sign-in details", not "client ID and secret": a site can now be
  // configured with an ordinary openEQUELLA username and password
  // (secrets.ts), and naming the OAuth credential would send most
  // institutions looking for something they do not have and cannot get.
  return `No credentials saved for ${label}. Add your sign-in details for that site in Setup.`;
}

/** The instance record the operator saved, or a refusal naming the id. */
async function requireInstanceRecord(instanceId: string): Promise<Instance> {
  return requireInstance(instanceId, await secrets().loadInstance(instanceId));
}

/** Both halves of an instance: what it is, and how to authenticate to it. */
async function requireSettings(instanceId: string) {
  const inst = await requireInstanceRecord(instanceId);
  const s = await secrets().loadSettings(inst.id);
  if (!s) throw new OeqError(missingCredentialsMessage(inst.label));
  return { inst, settings: s };
}

/**
 * Picks the on-disk location of the bundled schema export.
 *
 * In a packaged build the app runs out of an asar archive that does NOT
 * contain `schema/`; Task 9 instead copies the file to
 * `process.resourcesPath/schema/_entity.xml` via electron-builder's
 * `extraResources`. `app.isPackaged` is the standard Electron signal for
 * that case -- using it (rather than e.g. probing which path exists) keeps
 * this deterministic and makes the packaged path a real assertion instead of
 * a silent fallback that would only surface as a runtime "file not found"
 * inside an asar during a clean-machine test.
 *
 * The plan this was built from assumed `app.getAppPath()` is the repo root
 * in development. LIVE-VERIFIED FALSE for this project's actual launch
 * command (`electron dist-desktop/desktop/main.js`, from `npm run desktop`):
 * `app.getAppPath()` resolves to the directory containing the entry script
 * (`dist-desktop/desktop`) because there is no `package.json` there for
 * Electron to walk up to -- confirmed live via a CDP round trip that failed
 * with `ENOENT ...dist-desktop\desktop\schema\_entity.xml`. `appPath` here is
 * therefore NOT `app.getAppPath()` but computed from this module's own
 * compiled location (`dist-desktop/desktop/handlers.js`): two levels up is
 * the repo root, where `schema/_entity.xml` actually lives (it is not under
 * `src/`, so `tsc` never copies it). This only matters for the unpackaged
 * branch; the packaged branch is unaffected since it never reads `appPath`.
 *
 * Pulled out as a pure function, with the three inputs passed in rather than
 * read from `app`/`process`/`import.meta.url` directly, so the branch
 * selection is unit testable without booting Electron.
 */
export function resolveSchemaPath(opts: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string {
  return resolveResourcePath(opts, 'schema', '_entity.xml');
}

/**
 * General form of resolveSchemaPath's packaged/unpackaged branch, for any
 * file or directory that ships via electron-builder's `extraResources`
 * alongside `schema/_entity.xml` (see resolveSchemaPath's doc comment above
 * for the full story on why `appPath` is NOT `app.getAppPath()`, and why it
 * only matters for the unpackaged branch). `segments` is the path under the
 * resource root, e.g. `('schema', '_entity.xml')` or `('template',)` -- a
 * new bundled resource reuses this instead of re-deriving the same branch.
 */
export function resolveResourcePath(
  opts: { isPackaged: boolean; appPath: string; resourcesPath: string },
  ...segments: string[]
): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, ...segments)
    : join(opts.appPath, ...segments);
}

/** Directory containing this compiled module (dist-desktop/desktop at runtime). */
const here = dirname(fileURLToPath(import.meta.url));

/** The three inputs resolveResourcePath needs, read from `app`/`process` once per call site. */
function resourcePathOpts(): { isPackaged: boolean; appPath: string; resourcesPath: string } {
  return {
    isPackaged: app.isPackaged,
    // Repo root: see resolveSchemaPath's doc comment for why this is not
    // app.getAppPath().
    appPath: join(here, '..', '..'),
    resourcesPath: process.resourcesPath,
  };
}

/** Schema xpaths, read from the bundled reference export. */
async function schemaPaths(): Promise<Set<string>> {
  const p = resolveSchemaPath(resourcePathOpts());
  return parseSchemaPaths(extractDefinition(await readFile(p, 'utf8')));
}

/**
 * The title xpath the same export declares, or null if it declares none.
 *
 * Read rather than assumed: the duplicate check searches on this path, and a
 * hardcoded `MWDL/title` matches nothing outside BYU-Idaho -- which would
 * report every row clean from a check that never looked. Null reaches
 * findDuplicates as "could not check", never as "clean".
 */
async function schemaTitleHeader(): Promise<string | null> {
  const p = resolveSchemaPath(resourcePathOpts());
  return extractItemNamePath(await readFile(p, 'utf8'));
}

/**
 * The two files the starter kit (see CHANNELS.saveStarterKit below) copies
 * out for the operator: the blank/example template CSV, and the file its one
 * example row attaches. Exported so checkStarterKitDestination's tests can
 * assert against the same list this module actually copies, rather than a
 * second hand-typed copy that could silently drift from it.
 */
export const STARTER_KIT_FILES = ['upload-template.csv', 'sample-upload.txt'] as const;

/** Directory containing the bundled starter-kit template + sample file. */
function templateDir(): string {
  return resolveResourcePath(resourcePathOpts(), 'template');
}

/**
 * Decide whether copying the starter kit into a destination folder can
 * proceed, given the file names already present there. Pure -- no filesystem
 * access -- so the "do not silently overwrite" policy is unit-testable
 * without touching disk. Refuses on ANY collision, naming every file that
 * collides (not just the first), rather than overwriting something the
 * operator may have put there on purpose, or silently skipping just one of
 * the two files and leaving them with an incomplete, confusing kit.
 */
export function checkStarterKitDestination(
  existingNames: string[],
): { ok: true } | { ok: false; conflicts: string[] } {
  const existing = new Set(existingNames);
  const conflicts = STARTER_KIT_FILES.filter((f) => existing.has(f));
  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true };
}

/**
 * Apply the UI's column remaps to a sheet's headers AND every row's cell
 * keys, in memory only -- the user's spreadsheet on disk is never touched.
 * `overrides` maps an original header string to the xpath it should be
 * treated as. Both `headers` and each row's `cells` are rewritten from the
 * same `overrides` map so they can never key off different columns after
 * the swap (a header renamed but a cell key left stale would silently pair
 * the wrong metadata with the wrong xpath).
 */
export function applyOverrides(sheet: Sheet, overrides: Record<string, string>): Sheet {
  if (Object.keys(overrides).length === 0) return sheet;
  const headers = sheet.headers.map((h) => overrides[h] ?? h);
  const rows = sheet.rows.map((r) => {
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.cells)) cells[overrides[k] ?? k] = v;
    return { ...r, cells };
  });
  return { headers, rows };
}

/**
 * Build the per-column report for a set of headers against known schema
 * paths. Suggestions are populated ONLY for invalid headers: a column that
 * is already valid must never carry "did you mean..." alternatives on the
 * Review screen, where it reads to a non-technical user as "something is
 * wrong with this one" -- precisely backwards for a screen that exists to
 * make mapping less confusing. Shared by the `validate` and `plan` handlers
 * so the two can't drift apart on this rule.
 */
export function reportColumns(headers: string[], paths: Set<string>): ColumnReport[] {
  const { invalid } = validateHeaders(headers, paths);
  const invalidSet = new Map(invalid.map((i) => [i.header, i.suggestions]));
  return headers.map((h) => ({
    header: h,
    valid: !invalidSet.has(h),
    suggestions: invalidSet.get(h) ?? [],
    // Accepted, but not metadata. Saying only "valid" would imply the column
    // gets uploaded; the extractor writes these for the human reading the
    // spreadsheet and plan.ts drops them.
    ...(isAnnotationHeader(h) ? { ignored: true } : {}),
  }));
}

/**
 * `ipcMain` is taken as a parameter (mirroring registerExtractHandlers)
 * rather than imported and used directly, so tests can register against a
 * fake and exercise a handler without booting Electron -- see
 * tests/desktop/handlers.test.ts's `applyDuplicateChoices` suite.
 */
export function registerHandlers(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.listInstances, async () => secrets().listInstances());

  ipcMain.handle(CHANNELS.credentialsDropped, async () => secrets().credentialsDropped());

  ipcMain.handle(
    CHANNELS.hasSettings,
    async (_e, instanceId: Parameters<OeqApi['hasSettings']>[0]) => secrets().hasSettings(instanceId),
  );

  ipcMain.handle(
    CHANNELS.saveInstance,
    async (
      _e,
      instance: Parameters<OeqApi['saveInstance']>[0],
      s: Parameters<OeqApi['saveInstance']>[1],
    ) => secrets().saveInstance(instance, s),
  );

  ipcMain.handle(CHANNELS.clearSettings, async () => {
    await secrets().clear();
    await tokens().clear();
  });

  ipcMain.handle(
    CHANNELS.setPassword,
    async (_e, args: Parameters<OeqApi['setPassword']>[0]) =>
      secrets().setPassword(args.instanceId, args.username, args.password),
  );

  // Returns the USERNAME ONLY. The password never crosses back into the
  // renderer -- see OeqApi.getPassword for why.
  ipcMain.handle(
    CHANNELS.getPassword,
    async (_e, instanceId: Parameters<OeqApi['getPassword']>[0]) => {
      const stored = await secrets().getPassword(instanceId);
      return stored ? { username: stored.username } : null;
    },
  );

  ipcMain.handle(
    CHANNELS.forgetPassword,
    async (_e, instanceId: Parameters<OeqApi['forgetPassword']>[0]) =>
      secrets().forgetPassword(instanceId),
  );

  ipcMain.handle(
    CHANNELS.signIn,
    async (_e, instanceId: Parameters<OeqApi['signIn']>[0]) => {
      const { inst, settings } = await requireSettings(instanceId);
      const cfg = buildConfig(inst, settings, 'unused-for-signin');
      // Password auth has no browser flow to drive: UsernamePasswordAuth signs
      // in on its first request, so asking the site who is signed in IS the
      // sign-in, and its failure IS the "check the username and password"
      // error (core/passwordAuth.ts). Opening an SSO window here would present
      // an institution that has no SSO with a login page they cannot use.
      if (cfg.authMode === 'password') {
        return buildClient(cfg, buildAuth(cfg, tokens())).currentUser();
      }
      // buildCodeAuth, not buildAuth: this handler IS the authorization-code
      // browser flow, and signInInteractive needs that flow's own API.
      const auth = buildCodeAuth(cfg, tokens());
      await signInInteractive(cfg.baseUrl, auth, getWindow() ?? undefined);
      return buildClient(cfg, auth).currentUser();
    },
  );

  ipcMain.handle(CHANNELS.signOut, async () => {
    await tokens().clear();
  });

  ipcMain.handle(
    CHANNELS.currentUser,
    async (_e, instanceId: Parameters<OeqApi['currentUser']>[0]) => {
      const inst = await secrets().loadInstance(instanceId);
      if (!inst) return null;
      const settings = await secrets().loadSettings(inst.id);
      if (!settings) return null;
      const cfg = buildConfig(inst, settings, 'unused');
      const auth = buildAuth(cfg, tokens());
      try {
        return await buildClient(cfg, auth).currentUser();
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(
    CHANNELS.listCollections,
    async (_e, instanceId: Parameters<OeqApi['listCollections']>[0]) => {
      const { inst, settings } = await requireSettings(instanceId);
      const cfg = buildConfig(inst, settings, 'unused');
      const auth = buildAuth(cfg, tokens());
      // NOTE the signature: listCollections takes an OPTIONS OBJECT, not a
      // positional string. `listCollections('CREATE_ITEM')` does not compile.
      return buildClient(cfg, auth).listCollections({ privilege: 'CREATE_ITEM', length: 100 });
    },
  );

  // Read one schema and REMEMBER IT -- see fetchAndCacheSchema, which is
  // where the reasoning and the tests live.
  ipcMain.handle(
    CHANNELS.fetchSchema,
    async (_e, args: Parameters<OeqApi['fetchSchema']>[0]): Promise<SchemaSummary> => {
      const { inst, settings } = await requireSettings(args.instanceId);
      const cfg = buildConfig(inst, settings, 'unused');
      const client = buildClient(cfg, buildAuth(cfg, tokens()));
      return fetchAndCacheSchema(client, schemas(), inst.baseUrl, args.schemaUuid);
    },
  );

  ipcMain.handle(CHANNELS.chooseSpreadsheet, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle(CHANNELS.chooseFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  /**
   * Copies the starter-kit template CSV and its sample file into a folder
   * the operator picks, for the Choose screen's "Save a template and sample
   * file..." control. Returns the destination path on success (so the UI can
   * tell the operator exactly where to find them), or null if the folder
   * picker was cancelled -- matching chooseSpreadsheet/chooseFolder's own
   * cancel convention above.
   *
   * Never overwrites: checkStarterKitDestination refuses the whole copy (both
   * files, even if only one collides) with a message naming exactly which
   * file(s) are already there, rather than silently clobbering something the
   * operator may have put in that folder on purpose, or leaving them with
   * half a kit.
   */
  ipcMain.handle(CHANNELS.saveStarterKit, async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({
      title: 'Choose a folder to save the template and sample file',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const destDir = r.filePaths[0];

    let existingNames: string[];
    try {
      existingNames = await readdir(destDir);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new OeqError(`Could not read ${destDir}: ${detail}`);
    }

    const check = checkStarterKitDestination(existingNames);
    if (!check.ok) {
      const named = check.conflicts.map((f) => `'${f}'`).join(' and ');
      throw new OeqError(
        `${destDir} already has ${named}. Choose an empty folder, or move/rename the ` +
          `existing file(s) first, so nothing already there gets overwritten.`,
      );
    }

    const src = templateDir();
    try {
      for (const f of STARTER_KIT_FILES) {
        await copyFile(join(src, f), join(destDir, f));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new OeqError(`Could not save the starter kit to ${destDir}: ${detail}`);
    }

    return destDir;
  });

  ipcMain.handle(
    CHANNELS.validate,
    async (_e, args: Parameters<OeqApi['validate']>[0]): Promise<ColumnReport[]> => {
      const sheet = await readSheet(args.sheetPath);
      const paths = await schemaPaths();
      return reportColumns(sheet.headers, paths);
    },
  );

  ipcMain.handle(
    CHANNELS.plan,
    async (_e, args: Parameters<OeqApi['plan']>[0]): Promise<PlanReport> => {
      const { inst, settings } = await requireSettings(args.instanceId);
      const cfg = buildConfig(inst, settings, args.collectionUuid);
      const auth = buildAuth(cfg, tokens());
      const client = buildClient(cfg, auth);

      const sheet = applyOverrides(await readSheet(args.sheetPath), args.overrides ?? {});
      const paths = await schemaPaths();
      const manifest = await buildManifest(sheet, args.filesDir, paths, {
        baseUrl: cfg.baseUrl,
        collectionUuid: cfg.collectionUuid,
        schemaUuid: cfg.schemaUuid,
        itemState: args.itemState,
        attachmentUuidPath: cfg.attachmentUuidPath,
      });

      // Matches the CLI: fold advisory duplicate-identifier warnings into the
      // manifest at plan time so the reviewer sees them before confirming.
      manifest.warnings.push(...(await preflightDuplicates(client, manifest)));

      // One search per pending row. Advisory: nothing is skipped here, the
      // operator decides on the Review screen and the choices are applied by
      // the applyDuplicateChoices channel just before the run.
      //
      // A failure for one row becomes a `could-not-check` finding rather than
      // an exception, so an unreachable server cannot block a plan that is
      // otherwise ready -- and cannot be mistaken for a clean result either.
      const duplicates = await findDuplicates(client, manifest, await schemaTitleHeader());

      const manifestPath = join(userData(), 'job.json');
      await saveManifest(manifestPath, manifest);

      // Report columns against the OVERRIDDEN headers, so a column the user
      // remapped shows as valid. Do not hard-code `valid: true` -- if an
      // override is itself wrong (e.g. mapped to a still-invalid xpath), the
      // UI must still say so.
      const { invalid } = validateHeaders(sheet.headers, paths);
      return {
        manifestPath,
        entryCount: manifest.entries.length,
        columns: reportColumns(sheet.headers, paths),
        invalidHeaders: invalid,
        warnings: manifest.warnings,
        duplicates,
      };
    },
  );

  ipcMain.handle(
    CHANNELS.applyDuplicateChoices,
    async (_e, args: { manifestPath: string; skipRows: number[] }): Promise<number> => {
      // Applied to the SAVED manifest just before the run, because these are
      // the operator's choices, made after seeing the plan. The runner reads
      // this file, and `skipped` is already one of its terminal statuses, so
      // nothing in the runner needs to know this happened.
      const manifest = await loadManifest(args.manifestPath);
      const marked = markSkipped(
        manifest,
        args.skipRows,
        'skipped as a duplicate of an existing item',
      );
      await saveManifest(args.manifestPath, manifest);
      return marked;
    },
  );

  ipcMain.handle(
    CHANNELS.run,
    async (_e, args: Parameters<OeqApi['run']>[0]): Promise<RunReport> => {
      const { inst, settings } = await requireSettings(args.instanceId);
      const manifest = await loadManifest(args.manifestPath);
      const cfg = buildConfig(inst, settings, manifest.collectionUuid);
      const auth = buildAuth(cfg, tokens());
      const client = buildClient(cfg, auth);

      const summary = await runManifest(client, args.manifestPath, {
        onProgress: (entry, done, total) => {
          getWindow()?.webContents.send(CHANNELS.progress, {
            done,
            total,
            fileName: entry.fileName,
            status: entry.status,
            error: entry.error,
          });
        },
      });

      const done = await loadManifest(args.manifestPath);
      return {
        ...summary,
        failures: done.entries
          .filter((e) => e.status === 'failed')
          .map((e) => ({ rowNumber: e.rowNumber, fileName: e.fileName, error: e.error ?? 'unknown' })),
      };
    },
  );

  ipcMain.handle(
    CHANNELS.retryFailed,
    async (_e, manifestPath: Parameters<OeqApi['retryFailed']>[0]) => {
      const m = await loadManifest(manifestPath);
      for (const e of m.entries) {
        if (e.status === 'failed') {
          e.status = 'pending';
          e.attempts = 0;
          delete e.error;
        }
      }
      await saveManifest(manifestPath, m);
    },
  );

  ipcMain.handle(
    CHANNELS.loadManifest,
    async (_e, p: Parameters<OeqApi['loadManifest']>[0]) => loadManifest(p),
  );

  // Extract flow. Kept in its own module so this file does not keep growing,
  // and so the schema path is resolved once, here, where packaging is known.
  registerExtractHandlers(ipcMain, {
    schemaFile: resolveResourcePath(resourcePathOpts(), 'schema', '_entity.xml'),
    templatesDir: resolveResourcePath(resourcePathOpts(), 'templates'),
    // The site's OWN schema, when one has been fetched and cached, in
    // preference to the bundled export -- which is BYU-Idaho's and correct
    // nowhere else. Null falls back to the bundle; see cachedSchema.
    cachedSchema,
  });
}
