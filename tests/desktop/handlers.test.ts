import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { forgetLiveSessions, rememberSession } from '../../src/desktop/session.js';
import { SecretStore, EncryptedTokenStore, type Cipher } from '../../src/desktop/secrets.js';
import { saveManifest, loadManifest } from '../../src/core/state.js';
import { SchemaCache } from '../../src/core/schemaCache.js';
import type { SchemaInfo } from '../../src/core/discovery.js';
import type { Sheet, Manifest } from '../../src/core/types.js';

/**
 * registerHandlers ends up calling registerExtractHandlers, which resolves the
 * bundled schema path via `app.isPackaged` -- unmocked, 'electron' resolves to
 * nothing but a path string outside a real Electron process, so every named
 * export (app, dialog, safeStorage) comes back undefined and that read throws.
 *
 * `getPath` and `safeStorage` are here for the handlers that reach the
 * credential store (forgetPassword below). The "cipher" is deliberately the
 * identity transform: what is under test is which credentials survive a
 * handler, and a real DPAPI round trip is neither available nor relevant in a
 * bare Node process. `hoisted.userData` is repointed per test so each gets its
 * own store file.
 */
const hoisted = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => hoisted.userData },
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

/** The same transform the mocked safeStorage above applies, so a test can read
 *  back what a handler wrote. */
const plainCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8'),
  decrypt: (b) => b.toString('utf8'),
};

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

/**
 * "FORGET THIS PASSWORD" USED TO BE A HALF-LOGOUT.
 *
 * It removed the stored credential and left the openEQUELLA session live on
 * the server until the instance timed it out. An operator who clicks it --
 * plausibly because they are on a shared machine, or handing the laptop back
 * -- was told the credential was gone while a usable session carried on.
 *
 * The server session is ended FIRST, because it is the half that can fail; the
 * local forget then happens unconditionally. The operator asked for the
 * password to be gone, and that is not conditional on the network.
 */
describe('forgetPassword', () => {
  const SITE = 'https://oeq.example.edu';

  beforeEach(async () => {
    hoisted.userData = await mkdtemp(join(tmpdir(), 'oeq-forget-'));
    forgetLiveSessions();
  });

  /** A store pointed at the same file the handlers use, so this reads exactly
   *  what they wrote. */
  const store = () => new SecretStore(join(hoisted.userData, 'settings.enc'), plainCipher);

  async function savePassword(): Promise<void> {
    await store().saveInstance(
      { label: 'Live', baseUrl: SITE },
      { authMode: 'password', username: 'm.rowan', password: 'hunter2' },
    );
  }

  it('removes the stored password', async () => {
    await savePassword();
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:forgetPassword', SITE);

    expect(await store().getPassword(SITE)).toBeNull();
  });

  /**
   * THE MUTATION GUARD. Make the local forget conditional on the server
   * logout, and this goes red: the operator would be left with the credential
   * still on disk because a machine that is offline -- or a site that is down
   * -- said so.
   */
  it('removes the stored password even when ending the server session fails', async () => {
    await savePassword();
    rememberSession(SITE, {
      logout: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await expect(ipc.call('oeq:forgetPassword', SITE)).resolves.toBeUndefined();
    expect(await store().getPassword(SITE)).toBeNull();
  });

  it('ends the live session for that site', async () => {
    await savePassword();
    const ended = vi.fn(async () => {});
    rememberSession(SITE, { logout: ended });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:forgetPassword', SITE);

    expect(ended).toHaveBeenCalledTimes(1);
  });

  /**
   * Order, observed from inside the logout: the credential is still on disk
   * while the server session is being ended, and gone afterwards. Asserting
   * only the end state would pass against a handler that forgot first.
   */
  it('ends the server session before forgetting the credential', async () => {
    await savePassword();
    const seen: string[] = [];
    rememberSession(SITE, {
      logout: async () => {
        seen.push((await store().getPassword(SITE)) ? 'still stored' : 'already gone');
      },
    });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:forgetPassword', SITE);

    expect(seen).toEqual(['still stored']);
    expect(await store().getPassword(SITE)).toBeNull();
  });

  // Nothing signed in during this app run: there is no session to end, and
  // nothing may be signed in on the way to ending one.
  it('forgets the password with no session to end, and signs nothing in to do it', async () => {
    await savePassword();
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await expect(ipc.call('oeq:forgetPassword', SITE)).resolves.toBeUndefined();
    expect(await store().getPassword(SITE)).toBeNull();
  });

  // The site itself, its name and its address survive: Forget removes a
  // credential, not a configured instance.
  it('leaves the site configured', async () => {
    await savePassword();
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:forgetPassword', SITE);

    expect((await store().loadInstance(SITE))?.label).toBe('Live');
  });
});

/**
 * "SIGN OUT" USED TO BE A HALF-LOGOUT TOO -- and a whole one in password mode.
 *
 * It cleared the cached OAuth token and nothing else. That IS a complete
 * logout under the authorization-code flow, where the token is the session,
 * but password mode never writes the token store at all: the handler deleted a
 * file that had never been created, the renderer returned to the sign-in
 * screen, and the openEQUELLA session carried on until the server timed it
 * out. The button said Sign out, the app looked signed out, and the session
 * was live -- which on a shared machine is the difference between the control
 * working and merely appearing to.
 *
 * Same order as `forgetPassword` above: the server session first, because it
 * is the half that can fail, then the local clear unconditionally.
 */
describe('signOut', () => {
  const SITE = 'https://oeq.example.edu';
  const OTHER = 'https://other.example.edu';

  beforeEach(async () => {
    hoisted.userData = await mkdtemp(join(tmpdir(), 'oeq-signout-'));
    forgetLiveSessions();
  });

  /** Pointed at the same file the handlers use, so this reads what they wrote. */
  const tokenStore = () =>
    new EncryptedTokenStore(join(hoisted.userData, 'token.enc'), plainCipher);

  async function saveToken(): Promise<void> {
    await tokenStore().save({ accessToken: 'a-real-token', baseUrl: SITE });
  }

  it('ends the live session for the site being signed out of, and clears the token', async () => {
    await saveToken();
    const ended = vi.fn(async () => 'ended' as const);
    rememberSession(SITE, { logout: ended });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:signOut', SITE);

    expect(ended).toHaveBeenCalledTimes(1);
    expect(await tokenStore().loadRaw()).toBeNull();
  });

  /**
   * THE HANDLER HAS TO SAY WHAT IT DOES NOT KNOW.
   *
   * `logout()` never throws, on purpose (core/passwordAuth.ts): a logout that
   * failed is not worth interrupting anyone over. But it used to return
   * nothing either, so an unreachable site and a confirmed logout arrived here
   * identically, this handler resolved the same way for both, and the renderer
   * told the operator "signed out" -- true of this computer, unknown of the
   * server. On a shared machine that is the difference between the control
   * working and appearing to. The outcome comes back so the UI can say so.
   */
  it('reports a logout the server never confirmed', async () => {
    await saveToken();
    rememberSession(SITE, { logout: async () => 'unconfirmed' as const });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    expect(await ipc.call('oeq:signOut', SITE)).toEqual({ sessions: 1, unconfirmed: 1 });
    // AND the local half still happened. The report is a report, not a refusal.
    expect(await tokenStore().loadRaw()).toBeNull();
  });

  it('reports a confirmed logout as nothing to warn about', async () => {
    await saveToken();
    rememberSession(SITE, { logout: async () => 'ended' as const });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    expect(await ipc.call('oeq:signOut', SITE)).toEqual({ sessions: 1, unconfirmed: 0 });
  });

  /**
   * THE MUTATION GUARD for `endSessionsFor` vs `endAllSessions`. An operator
   * with a test site and a production site signed in to both would otherwise
   * be signed out of the one they did not ask about -- a surprising side
   * effect on a security control is its own defect.
   */
  it('does not end another site’s session', async () => {
    const mine = vi.fn(async () => 'ended' as const);
    const theirs = vi.fn(async () => 'ended' as const);
    rememberSession(SITE, { logout: mine });
    rememberSession(OTHER, { logout: theirs });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:signOut', SITE);

    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  /**
   * THE MUTATION GUARD for the order. Make the local clear conditional on the
   * server logout and this goes red: the operator asked to be signed out, and
   * that half is not conditional on the network being up.
   */
  it('clears the token even when ending the server session fails', async () => {
    await saveToken();
    rememberSession(SITE, {
      logout: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    // Reported, not thrown, and not conditional: the operator asked to be
    // signed out and that half is not conditional on the network being up.
    await expect(ipc.call('oeq:signOut', SITE)).resolves.toEqual({ sessions: 1, unconfirmed: 1 });
    expect(await tokenStore().loadRaw()).toBeNull();
  });

  // Nothing signed in during this app run -- OAuth mode, or a fresh launch.
  // There is no session to end, and nothing may be signed in to end one.
  it('clears the token with no session to end, and signs nothing in to do it', async () => {
    await saveToken();
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    // Nothing to end is nothing to warn about: an operator whose site never
    // signed in must not be told their session may still be live.
    await expect(ipc.call('oeq:signOut', SITE)).resolves.toEqual({ sessions: 0, unconfirmed: 0 });
    expect(await tokenStore().loadRaw()).toBeNull();
  });

  /**
   * Order, observed from inside the logout: the token is still on disk while
   * the server session is being ended. Asserting only the end state would pass
   * against a handler that cleared first -- which is not merely a different
   * order, since the token is what an OAuth-mode logout would need to prove
   * who it is.
   */
  it('ends the server session before clearing the token', async () => {
    await saveToken();
    const seen: string[] = [];
    rememberSession(SITE, {
      logout: async () => {
        seen.push((await tokenStore().loadRaw()) ? 'still stored' : 'already gone');
        return 'ended' as const;
      },
    });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:signOut', SITE);

    expect(seen).toEqual(['still stored']);
    expect(await tokenStore().loadRaw()).toBeNull();
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
