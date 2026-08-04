import { app, dialog, ipcMain, safeStorage, type BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { CHANNELS, INSTANCES, type ColumnReport, type OeqApi, type PlanReport, type RunReport } from './ipc.js';
import { SecretStore, EncryptedTokenStore } from './secrets.js';
import { buildAuth, buildClient, buildConfig, instanceById } from './session.js';
import { readSheet } from '../core/sheet.js';
import { extractDefinition, parseSchemaPaths, validateHeaders } from '../core/schema.js';
import { buildManifest, preflightDuplicates } from '../core/plan.js';
import { saveManifest, loadManifest } from '../core/state.js';
import { runManifest } from '../core/runner.js';
import { signInInteractive } from './signin.js';
import type { Sheet } from '../core/types.js';
import { OeqError } from '../core/errors.js';

const userData = () => app.getPath('userData');

const cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s: string) => safeStorage.encryptString(s),
  decrypt: (b: Buffer) => safeStorage.decryptString(b),
};

const secrets = () => new SecretStore(join(userData(), 'settings.enc'), cipher);
const tokens = () => new EncryptedTokenStore(join(userData(), 'token.enc'), cipher);

/**
 * The exact wording an operator sees when the instance they've selected has
 * no saved credentials. Names the instance -- with credentials now per
 * instance (see secrets.ts), a bare "no credentials" would be actively
 * confusing: which one? Falls back to the raw id for a value that isn't a
 * known instance rather than crashing; `instanceById` (session.ts) already
 * rejects a truly bogus id earlier in the same call, so this fallback only
 * matters for whatever calls this function directly without going through
 * that guard first.
 */
export function missingCredentialsMessage(instanceId: string): string {
  const label = INSTANCES.find((i) => i.id === instanceId)?.label ?? instanceId;
  return `No credentials saved for ${label}. Enter the client ID and secret for that instance in Setup.`;
}

async function requireSettings(instanceId: string) {
  const inst = instanceById(instanceId);
  const s = await secrets().loadSettings(inst.id);
  if (!s) throw new OeqError(missingCredentialsMessage(inst.id));
  return s;
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
  return opts.isPackaged
    ? join(opts.resourcesPath, 'schema', '_entity.xml')
    : join(opts.appPath, 'schema', '_entity.xml');
}

/** Directory containing this compiled module (dist-desktop/desktop at runtime). */
const here = dirname(fileURLToPath(import.meta.url));

/** Schema xpaths, read from the bundled reference export. */
async function schemaPaths(): Promise<Set<string>> {
  const p = resolveSchemaPath({
    isPackaged: app.isPackaged,
    // Repo root: see resolveSchemaPath's doc comment for why this is not
    // app.getAppPath().
    appPath: join(here, '..', '..'),
    resourcesPath: process.resourcesPath,
  });
  return parseSchemaPaths(extractDefinition(await readFile(p, 'utf8')));
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
  }));
}

export function registerHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    CHANNELS.hasSettings,
    async (_e, instanceId: Parameters<OeqApi['hasSettings']>[0]) => {
      const inst = instanceById(instanceId);
      return secrets().hasSettings(inst.id);
    },
  );

  ipcMain.handle(
    CHANNELS.saveSettings,
    async (
      _e,
      instanceId: Parameters<OeqApi['saveSettings']>[0],
      s: Parameters<OeqApi['saveSettings']>[1],
    ) => {
      const inst = instanceById(instanceId);
      await secrets().saveSettings(inst.id, s);
    },
  );

  ipcMain.handle(CHANNELS.clearSettings, async () => {
    await secrets().clear();
    await tokens().clear();
  });

  ipcMain.handle(
    CHANNELS.signIn,
    async (_e, instanceId: Parameters<OeqApi['signIn']>[0]) => {
      const settings = await requireSettings(instanceId);
      const cfg = buildConfig(instanceId, settings, 'unused-for-signin');
      const auth = buildAuth(cfg, tokens());
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
      const inst = instanceById(instanceId);
      const settings = await secrets().loadSettings(inst.id);
      if (!settings) return null;
      const cfg = buildConfig(instanceId, settings, 'unused');
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
      const settings = await requireSettings(instanceId);
      const cfg = buildConfig(instanceId, settings, 'unused');
      const auth = buildAuth(cfg, tokens());
      // NOTE the signature: listCollections takes an OPTIONS OBJECT, not a
      // positional string. `listCollections('CREATE_ITEM')` does not compile.
      return buildClient(cfg, auth).listCollections({ privilege: 'CREATE_ITEM', length: 100 });
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
      const settings = await requireSettings(args.instanceId);
      const cfg = buildConfig(args.instanceId, settings, args.collectionUuid);
      const auth = buildAuth(cfg, tokens());
      const client = buildClient(cfg, auth);

      const sheet = applyOverrides(await readSheet(args.sheetPath), args.overrides ?? {});
      const paths = await schemaPaths();
      const manifest = await buildManifest(sheet, args.filesDir, paths, {
        baseUrl: cfg.baseUrl,
        collectionUuid: cfg.collectionUuid,
        schemaUuid: cfg.schemaUuid,
        itemState: args.itemState,
      });

      // Matches the CLI: fold advisory duplicate-identifier warnings into the
      // manifest at plan time so the reviewer sees them before confirming.
      manifest.warnings.push(...(await preflightDuplicates(client, manifest)));

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
      };
    },
  );

  ipcMain.handle(
    CHANNELS.run,
    async (_e, args: Parameters<OeqApi['run']>[0]): Promise<RunReport> => {
      const settings = await requireSettings(args.instanceId);
      const manifest = await loadManifest(args.manifestPath);
      const cfg = buildConfig(args.instanceId, settings, manifest.collectionUuid);
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
}
