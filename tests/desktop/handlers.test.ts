import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyOverrides,
  fetchAndCacheSchema,
  reportColumns,
  resolveSchemaPath,
  missingCredentialsMessage,
  registerHandlers,
  requireSignedIn,
} from '../../src/desktop/handlers.js';
import { saveManifest, loadManifest } from '../../src/core/state.js';
import { SchemaCache } from '../../src/core/schemaCache.js';
import type { SchemaInfo } from '../../src/core/discovery.js';
import type { Sheet, Manifest } from '../../src/core/types.js';

// registerHandlers ends up calling registerExtractHandlers, which resolves the
// bundled schema path via `app.isPackaged` -- unmocked, 'electron' resolves to
// nothing but a path string outside a real Electron process, so every named
// export (app, dialog, safeStorage) comes back undefined and that read
// throws. This is the smallest mock that lets registration complete: just
// enough of `app` to pick the unpackaged branch, nothing else touched.
vi.mock('electron', () => ({
  app: { isPackaged: false },
  dialog: {},
  safeStorage: {},
}));

/** A stand-in for Electron's ipcMain that just records the handlers. Copied from extractHandlers.test.ts. */
function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
  return {
    handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown) {
      handlers.set(channel, fn);
    },
    call<T>(channel: string, ...args: unknown[]): Promise<T> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return Promise.resolve(fn({}, ...args) as T);
    },
    channels: () => [...handlers.keys()],
  };
}

/** registerHandlers' second argument: a getWindow callback. No test here needs a real window. */
function getWindowStub(): () => null {
  return () => null;
}

describe('applyOverrides', () => {
  const sheet: Sheet = {
    headers: ['Creator', 'Title', 'attachment name'],
    rows: [
      {
        rowNumber: 2,
        cells: { Creator: 'Ada Lovelace', Title: 'Notes', 'attachment name': 'a.mp4' },
      },
      {
        rowNumber: 3,
        cells: { Creator: 'Alan Turing', Title: 'Paper', 'attachment name': 'b.mp4' },
      },
    ],
  };

  it('returns the sheet unchanged (same reference) when there are no overrides', () => {
    expect(applyOverrides(sheet, {})).toBe(sheet);
  });

  it('remaps a single column in both headers and every row', () => {
    const result = applyOverrides(sheet, { Creator: 'MWDL/creator' });
    expect(result.headers).toEqual(['MWDL/creator', 'Title', 'attachment name']);
    expect(result.rows[0]!.cells).toEqual({
      'MWDL/creator': 'Ada Lovelace',
      Title: 'Notes',
      'attachment name': 'a.mp4',
    });
    expect(result.rows[1]!.cells).toEqual({
      'MWDL/creator': 'Alan Turing',
      Title: 'Paper',
      'attachment name': 'b.mp4',
    });
  });

  it('remaps several columns at once, consistently across headers and cells', () => {
    const result = applyOverrides(sheet, {
      Creator: 'MWDL/creator',
      Title: 'MWDL/title',
    });
    expect(result.headers).toEqual(['MWDL/creator', 'MWDL/title', 'attachment name']);
    for (const row of result.rows) {
      expect(Object.keys(row.cells).sort()).toEqual(
        ['MWDL/creator', 'MWDL/title', 'attachment name'].sort(),
      );
    }
    expect(result.rows[0]!.cells['MWDL/creator']).toBe('Ada Lovelace');
    expect(result.rows[0]!.cells['MWDL/title']).toBe('Notes');
  });

  it('leaves columns with no override untouched', () => {
    const result = applyOverrides(sheet, { Creator: 'MWDL/creator' });
    expect(result.headers).toContain('Title');
    expect(result.headers).toContain('attachment name');
    expect(result.rows[0]!.cells['Title']).toBe('Notes');
    expect(result.rows[0]!.cells['attachment name']).toBe('a.mp4');
  });

  it('keeps headers and every row cells-key set consistent (no drift)', () => {
    const result = applyOverrides(sheet, { Creator: 'MWDL/creator', Title: 'MWDL/title' });
    const headerSet = new Set(result.headers);
    for (const row of result.rows) {
      expect(new Set(Object.keys(row.cells))).toEqual(headerSet);
    }
  });

  it('does not mutate the original sheet', () => {
    const before = JSON.parse(JSON.stringify(sheet));
    applyOverrides(sheet, { Creator: 'MWDL/creator' });
    expect(sheet).toEqual(before);
  });

  it('an override key that does not match any header is harmless', () => {
    const result = applyOverrides(sheet, { NoSuchColumn: 'MWDL/whatever' });
    expect(result.headers).toEqual(sheet.headers);
  });
});

describe('reportColumns', () => {
  // 'attachment name' is valid via schema.ts's own RESERVED set, independent
  // of what's in `paths` -- included here to also cover that a valid header
  // never carries suggestions regardless of why it's valid.
  const paths = new Set(['MWDL/title', 'MWDL/identifier']);

  it('a valid header comes back with an empty suggestions list', () => {
    const [report] = reportColumns(['MWDL/title'], paths);
    expect(report).toEqual({ header: 'MWDL/title', valid: true, suggestions: [] });
  });

  it('the reserved attachment-name column is valid with no suggestions', () => {
    const [report] = reportColumns(['attachment name'], paths);
    expect(report).toEqual({ header: 'attachment name', valid: true, suggestions: [] });
  });

  it('an invalid header comes back with a non-empty suggestions list', () => {
    // One edit away from 'MWDL/title' -- close enough that schema.ts's
    // `suggest()` is expected to surface it.
    const [report] = reportColumns(['MWDL/titel'], paths);
    expect(report!.valid).toBe(false);
    expect(report!.suggestions.length).toBeGreaterThan(0);
    expect(report!.suggestions).toContain('MWDL/title');
  });

  it('an invalid header with no plausible match still comes back with an empty list, never a crash', () => {
    const [report] = reportColumns(['Completely Unrelated Nonsense'], paths);
    expect(report!.valid).toBe(false);
    expect(report!.suggestions).toEqual([]);
  });

  it('reports each header independently in a mixed set', () => {
    const result = reportColumns(['MWDL/title', 'Some Bogus Header', 'attachment name'], paths);
    expect(result).toEqual([
      { header: 'MWDL/title', valid: true, suggestions: [] },
      { header: 'Some Bogus Header', valid: false, suggestions: [] },
      { header: 'attachment name', valid: true, suggestions: [] },
    ]);
  });
});

describe('missingCredentialsMessage', () => {
  // The exact wording an operator sees when they pick a site that has never
  // had credentials saved -- it must name the site, so "no credentials" is
  // not ambiguous between the several they may have added. It is given the
  // LABEL rather than the id, because the label is what they picked from the
  // dropdown; the id is the address.
  it('names the site the operator chose', () => {
    expect(missingCredentialsMessage('Production')).toBe(
      'No credentials saved for Production. Add your sign-in details for that site in Setup.',
    );
    expect(missingCredentialsMessage('Test')).toBe(
      'No credentials saved for Test. Add your sign-in details for that site in Setup.',
    );
  });

  // An operator who left the name blank gets the host as their label
  // (secrets.ts), so there is always something to name here -- the message
  // never degrades to a bare "no credentials".
  it('names a host-derived label just as readably', () => {
    expect(missingCredentialsMessage('oeq.example.edu')).toBe(
      'No credentials saved for oeq.example.edu. Add your sign-in details for that site in Setup.',
    );
  });
});

/**
 * A SIGN-IN THAT PRODUCED THE GUEST IS NOT A SIGN-IN. openEQUELLA never
 * answers an unauthenticated request with 401 -- it answers 200 as the guest
 * identity -- so without this the desktop's sign-in handler resolved a
 * perfectly good user object, the app advanced to the next screen reporting
 * success, and the first the operator heard of it was a collection dropdown
 * reading "No collections match".
 */
describe('requireSignedIn', () => {
  const guest = { id: 'guest', username: 'guest', firstName: 'guest', lastName: 'guest', guest: true };
  const real = { id: 'u-1', username: 'jdoe', firstName: 'Jane', lastName: 'Doe', guest: false };

  it('refuses a guest session rather than reporting it as a sign-in', () => {
    expect(() => requireSignedIn(guest, 'Live')).toThrow(/guest/i);
  });

  // Names the site: credentials are per instance, and the operator picked
  // theirs from a dropdown of their own names for them.
  it('names the site and what to do about it', () => {
    const message = (() => {
      try {
        requireSignedIn(guest, 'Live');
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).toContain('Live');
    expect(message).toMatch(/setup/i);
    // ...and says what it means for a run, not just that something is wrong.
    expect(message).toMatch(/nothing can be created/i);
  });

  it('passes a real account straight through', () => {
    expect(requireSignedIn(real, 'Live')).toBe(real);
  });
});

describe('resolveSchemaPath', () => {
  it('resolves under the app path when unpackaged (development)', () => {
    const p = resolveSchemaPath({
      isPackaged: false,
      appPath: 'C:\\repo',
      resourcesPath: 'C:\\repo\\dist-desktop',
    });
    expect(p.replace(/\\/g, '/')).toBe('C:/repo/schema/_entity.xml');
  });

  it('resolves under resourcesPath when packaged, ignoring appPath', () => {
    const p = resolveSchemaPath({
      isPackaged: true,
      appPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\app\\resources\\app.asar',
      resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\app\\resources',
    });
    expect(p.replace(/\\/g, '/')).toBe(
      'C:/Users/me/AppData/Local/Programs/app/resources/schema/_entity.xml',
    );
  });
});

describe('applyDuplicateChoices', () => {
  function manifestWithRows(rowNumbers: number[]): Manifest {
    return {
      version: 1,
      createdAt: '2026-08-06T00:00:00.000Z',
      baseUrl: 'https://example.test',
      collectionUuid: 'c1',
      schemaUuid: 's1',
      itemState: 'draft',
      attachmentColumn: 'attachment name',
      warnings: [],
      entries: rowNumbers.map((rowNumber) => ({
        rowNumber,
        filePath: `/f/${rowNumber}.pdf`,
        fileName: `${rowNumber}.pdf`,
        metadata: {},
        status: 'pending' as const,
        attempts: 0,
      })),
    };
  }

  async function manifestFile(rowNumbers: number[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-dup-'));
    const path = join(dir, 'job.json');
    await saveManifest(path, manifestWithRows(rowNumbers));
    return path;
  }

  it('marks only the chosen rows skipped', async () => {
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());
    const manifestPath = await manifestFile([2, 3]);

    const marked = await ipc.call<number>('oeq:applyDuplicateChoices', {
      manifestPath,
      skipRows: [2],
    });

    expect(marked).toBe(1);
    const manifest = await loadManifest(manifestPath);
    expect(manifest.entries.find((e) => e.rowNumber === 2)?.status).toBe('skipped');
    expect(manifest.entries.find((e) => e.rowNumber === 3)?.status).toBe('pending');
  });

  it('records why the row was skipped', async () => {
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());
    const manifestPath = await manifestFile([2]);
    await ipc.call<number>('oeq:applyDuplicateChoices', { manifestPath, skipRows: [2] });
    const manifest = await loadManifest(manifestPath);
    expect(manifest.entries[0]?.error).toMatch(/duplicate/i);
  });

  it('marks nothing when the operator chose to skip nothing', async () => {
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());
    const manifestPath = await manifestFile([2]);
    expect(
      await ipc.call<number>('oeq:applyDuplicateChoices', { manifestPath, skipRows: [] }),
    ).toBe(0);
  });

  // The saved manifest is what the runner reads. A change kept only in memory
  // would be a skip the operator was shown and that then did not happen.
  it('persists the change to disk, not just in memory', async () => {
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());
    const manifestPath = await manifestFile([2]);
    await ipc.call<number>('oeq:applyDuplicateChoices', { manifestPath, skipRows: [2] });
    const reread = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    expect(reread.entries[0]?.status).toBe('skipped');
  });
});

/**
 * The write half of the offline schema cache.
 *
 * `src/core/extract/` never touches the network -- that is what lets an
 * operator build a spreadsheet without signing in to anything -- but the
 * schema it validates columns against comes from the API. This is the moment
 * those two are reconciled: whoever DID sign in leaves the schema on disk,
 * keyed by (instance url, schema uuid), and extraction reads it later.
 */
describe('fetchAndCacheSchema', () => {
  const SITE = 'https://oeq.example.edu';
  const schema: SchemaInfo = {
    uuid: 'schema-1',
    namePath: '/MWDL/title',
    titleHeader: 'MWDL/title',
    descriptionPath: '/MWDL/description',
    descriptionHeader: 'MWDL/description',
    paths: new Set(['MWDL/title', 'MWDL/description']),
  };
  const fakeClient = { getSchema: async () => schema };

  it('writes the fetched schema where extraction reads it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-sc-'));
    const cache = new SchemaCache(dir);
    await fetchAndCacheSchema(fakeClient, cache, SITE, 'schema-1');
    // Read back through the cache's OWN key, which is what the extract
    // handlers use. A write under any other key is a write nobody can find.
    expect(await cache.load(SITE, 'schema-1')).toEqual(schema);
  });

  /**
   * KEYED ON THE INSTANCE AS WELL AS THE SCHEMA. Schema uuids are not globally
   * unique across institutions, and one institution's test and production
   * instances routinely share them outright -- keying on the uuid alone would
   * let one site's schema answer for another's, silently, with paths that look
   * entirely real.
   */
  it('does not let one site’s schema answer for another’s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-sc-'));
    const cache = new SchemaCache(dir);
    await fetchAndCacheSchema(fakeClient, cache, SITE, 'schema-1');
    expect(await cache.load('https://oeq-test.example.edu', 'schema-1')).toBeNull();
  });

  it('answers with the schema flattened for the IPC boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-sc-'));
    const summary = await fetchAndCacheSchema(fakeClient, new SchemaCache(dir), SITE, 'schema-1');
    // An array, not a Set: JSON.stringify renders a Set as `{}`, and every
    // valid xpath would be lost while the payload still looked plausible.
    expect(summary.paths).toEqual(['MWDL/description', 'MWDL/title']);
    expect(summary.titleHeader).toBe('MWDL/title');
  });

  /**
   * The operator asked to see a schema, not to populate a cache. A full or
   * read-only disk must not turn "here are your collection's fields" into an
   * error dialog -- all that is actually lost is a later offline validation
   * that degrades to the bundled export anyway.
   */
  it('still answers when the cache cannot be written', async () => {
    const brokenCache = {
      save: async () => {
        throw new Error('disk full');
      },
    };
    const summary = await fetchAndCacheSchema(fakeClient, brokenCache, SITE, 'schema-1');
    expect(summary.uuid).toBe('schema-1');
  });

  // A fetch that fails is a real failure and is reported as one -- unlike the
  // cache write above, there is no answer to give.
  it('does not swallow a failure to read the schema itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-sc-'));
    const failing = {
      getSchema: async () => {
        throw new Error('404 not found');
      },
    };
    await expect(fetchAndCacheSchema(failing, new SchemaCache(dir), SITE, 'nope')).rejects.toThrow(/404/);
  });
});
