import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  planAction,
  runAction,
  statusAction,
  retryAction,
  loginAction,
  logoutAction,
  checkAction,
  stripBomFromEnvKeys,
  extractCode,
  browserCommand,
} from '../src/cli/index.js';
import { acquireLock, releaseLock } from '../src/core/lock.js';
import { saveManifest, loadManifest } from '../src/core/state.js';
import { loadConfig } from '../src/core/config.js';
import { AuthorizationCodeAuth } from '../src/core/authCode.js';
import { FileTokenStore } from '../src/core/tokenStore.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';
import type { Manifest } from '../src/core/types.js';

/** Captures console.log output for the duration of `fn`, restoring it after -- even on throw. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

/** Grabs an OS-assigned free loopback port, for tests that need to know a
 *  port number before `loginAction` starts its own loopback server on it. */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

/** Polls `127.0.0.1:<port>` until a raw TCP connection succeeds -- used to
 *  wait for `loginAction`'s loopback server to actually be listening before
 *  firing the simulated browser redirect at it. A raw `net.connect` probe
 *  (rather than `fetch`) so a not-yet-listening port fails fast: on Windows,
 *  `fetch`'s HTTP-level connect can take seconds to report ECONNREFUSED. */
function probeConnect(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const conn = connect({ host: '127.0.0.1', port }, () => {
      conn.destroy();
      resolveProbe(true);
    });
    conn.on('error', () => {
      conn.destroy();
      resolveProbe(false);
    });
  });
}

async function waitForPort(port: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeConnect(port)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for 127.0.0.1:${port} to accept connections.`);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-cli-'));
});

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  version: 1,
  createdAt: '2026-08-03T00:00:00.000Z',
  baseUrl: 'https://example.test',
  collectionUuid: 'c1',
  schemaUuid: 's1',
  itemState: 'draft',
  attachmentColumn: 'attachment name',
  warnings: [],
  entries: [],
  ...overrides,
});

describe('planAction --state validation', () => {
  it('rejects a bogus --state before touching the filesystem or environment', async () => {
    await expect(
      planAction(
        {
          sheet: 'does-not-exist.csv',
          files: 'does-not-exist-dir',
          manifest: join(dir, 'job.json'),
          schemaFile: 'does-not-exist.xml',
          state: 'bogus',
        },
        {},
      ),
    ).rejects.toThrow(/--state must be 'draft' or 'published'/);
  });

  it('accepts draft and published', async () => {
    // Neither reaches loadConfig with a bogus state, so this only proves
    // valid values pass the guard -- config/file errors surface afterward.
    await expect(
      planAction(
        {
          sheet: 'x',
          files: 'y',
          manifest: 'z',
          schemaFile: 'w',
          state: 'draft',
        },
        {},
      ),
    ).rejects.not.toThrow(/--state must be/);
  });
});

describe('retryAction and a live lock', () => {
  it('refuses to run, and does not write, while a live lock is held', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: {},
          status: 'failed',
          attempts: 3,
          error: 'boom',
        },
      ],
    });
    await saveManifest(path, m);
    // acquireLock() records the current process's own pid, which is always
    // alive -- the definitionally-live lock the task calls for.
    await acquireLock(path);
    try {
      await expect(retryAction({ manifest: path })).rejects.toThrow(new RegExp(String(process.pid)));
      const stillLocked = await loadManifest(path);
      expect(stillLocked.entries[0]!.status).toBe('failed');
      expect(stillLocked.entries[0]!.attempts).toBe(3);
    } finally {
      await releaseLock(path);
    }
  });

  it('resets failed entries to pending (and attempts to 0) when no lock is held', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: {},
          status: 'failed',
          attempts: 3,
          error: 'boom',
        },
        {
          rowNumber: 3,
          filePath: join(dir, 'b.mp4'),
          fileName: 'b.mp4',
          metadata: {},
          status: 'created',
          attempts: 1,
          itemUuid: 'item-1',
        },
      ],
    });
    await saveManifest(path, m);

    await retryAction({ manifest: path });

    const after = await loadManifest(path);
    expect(after.entries[0]!.status).toBe('pending');
    expect(after.entries[0]!.attempts).toBe(0);
    expect(after.entries[0]!.error).toBeUndefined();
    // A row that already succeeded must never be touched by retry.
    expect(after.entries[1]!.status).toBe('created');
    expect(after.entries[1]!.attempts).toBe(1);
  });

  it('does not reset entries left "uploading" (interrupted-at-load) -- that needs --force-interrupted on run', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: {},
          status: 'uploading',
          attempts: 1,
          error: 'a previous run was interrupted while processing this row.',
        },
      ],
    });
    await saveManifest(path, m);

    await retryAction({ manifest: path });

    const after = await loadManifest(path);
    expect(after.entries[0]!.status).toBe('uploading');
  });
});

describe('statusAction', () => {
  it('reports counts and the lock holder', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: {},
          status: 'failed',
          attempts: 1,
          error: 'boom',
        },
      ],
    });
    await saveManifest(path, m);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await statusAction({ manifest: path });
    } finally {
      console.log = orig;
    }
    expect(logs.join('\n')).toContain('"failed": 1');
    expect(logs.join('\n')).toContain('No active lock.');
  });
});

describe('runAction exit code', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer();
  });
  afterEach(async () => {
    await mock.close();
  });

  const env = () => ({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: 'secret',
    OEQ_COLLECTION_UUID: 'c1',
  });

  it('returns 0 when nothing failed, even if rows were interrupted', async () => {
    const path = join(dir, 'job.json');
    await writeFile(join(dir, 'a.mp4'), Buffer.alloc(8));
    const m = manifest({
      baseUrl: mock.url,
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: { 'MWDL/title': ['a'] },
          status: 'uploading',
          attempts: 1,
        },
      ],
    });
    await saveManifest(path, m);

    const code = await runAction({ manifest: path }, env());
    expect(code).toBe(0);
    const after = await loadManifest(path);
    expect(after.entries[0]!.status).toBe('uploading');
  });

  it('returns 1 when any row genuinely failed', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      baseUrl: mock.url,
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'does-not-exist.mp4'),
          fileName: 'does-not-exist.mp4',
          metadata: { 'MWDL/title': ['a'] },
          status: 'pending',
          attempts: 0,
        },
      ],
    });
    await saveManifest(path, m);

    const code = await runAction({ manifest: path, maxAttempts: 1 }, env());
    expect(code).toBe(1);
  });
});

describe('planAction duplicate check', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer();
  });
  afterEach(async () => {
    await mock.close();
  });

  // client_credentials so findDuplicates' real searchByTitle call can get a
  // token from the mock without a login flow -- matches how runAction's own
  // tests in this file drive the mock server.
  const mockEnv = () => ({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: 'secret',
    OEQ_COLLECTION_UUID: 'c1',
    OEQ_AUTH_MODE: 'client_credentials',
  });

  /** A one-row sheet with just enough columns for the duplicate check: a
   *  title (what searchByTitle matches on) and the attachment filename. */
  async function writeTitleSheet(sheetDir: string, fileName = 'clip1.mp4'): Promise<string> {
    const sheetPath = join(sheetDir, 'batch.csv');
    await writeFile(sheetPath, ['attachment name,MWDL/title', `${fileName},Test Clip One`].join('\n'));
    await writeFile(join(sheetDir, fileName), 'x');
    return sheetPath;
  }

  const plan = (
    sheetPath: string,
    manifestPath: string,
    overrides: Partial<Parameters<typeof planAction>[0]> = {},
  ) =>
    planAction(
      {
        sheet: sheetPath,
        files: dir,
        manifest: manifestPath,
        schemaFile: 'schema/_entity.xml',
        state: 'draft',
        ...overrides,
      },
      mockEnv(),
    );

  it('marks a near-certain duplicate row skipped in the saved manifest', async () => {
    mock.state.existingItems = [
      { uuid: 'existing-1', version: 1, title: 'Test Clip One', attachmentNames: ['clip1.mp4'] },
    ];
    const sheetPath = await writeTitleSheet(dir);
    const manifestPath = join(dir, 'job.json');

    await plan(sheetPath, manifestPath);

    const saved = await loadManifest(manifestPath);
    expect(saved.entries[0]!.status).toBe('skipped');
  });

  it('leaves the row pending when --upload-duplicates is passed', async () => {
    mock.state.existingItems = [
      { uuid: 'existing-1', version: 1, title: 'Test Clip One', attachmentNames: ['clip1.mp4'] },
    ];
    const sheetPath = await writeTitleSheet(dir);
    const manifestPath = join(dir, 'job.json');

    await plan(sheetPath, manifestPath, { uploadDuplicates: true });

    const saved = await loadManifest(manifestPath);
    expect(saved.entries[0]!.status).toBe('pending');
  });

  it('leaves the row pending for a title-only ("possible") match -- a shared title is not proof', async () => {
    mock.state.existingItems = [
      {
        uuid: 'existing-1',
        version: 1,
        title: 'Test Clip One',
        attachmentNames: ['some-other-file.mp4'],
      },
    ];
    const sheetPath = await writeTitleSheet(dir);
    const manifestPath = join(dir, 'job.json');

    await plan(sheetPath, manifestPath);

    const saved = await loadManifest(manifestPath);
    expect(saved.entries[0]!.status).toBe('pending');
  });

  it('--skip-duplicate-check never looks, so the row stays pending even though it would have matched', async () => {
    mock.state.existingItems = [
      { uuid: 'existing-1', version: 1, title: 'Test Clip One', attachmentNames: ['clip1.mp4'] },
    ];
    const sheetPath = await writeTitleSheet(dir);
    const manifestPath = join(dir, 'job.json');

    await plan(sheetPath, manifestPath, { skipDuplicateCheck: true });

    const saved = await loadManifest(manifestPath);
    expect(saved.entries[0]!.status).toBe('pending');
    expect(mock.state.issuedTokens).toHaveLength(0);
  });

  it('prints the flagged row', async () => {
    mock.state.existingItems = [
      { uuid: 'existing-1', version: 1, title: 'Test Clip One', attachmentNames: ['clip1.mp4'] },
    ];
    const sheetPath = await writeTitleSheet(dir);
    const manifestPath = join(dir, 'job.json');

    const logs = await captureLogs(() => plan(sheetPath, manifestPath).then(() => undefined));

    const out = logs.join('\n');
    expect(out).toContain('Row 2: clip1.mp4');
    expect(out).toContain('near-certain');
  });
});

describe('loginAction', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer();
    // Bug 3: the redirect URI's host now controls whether loginAction starts
    // a real loopback server. The mock server itself listens on 127.0.0.1,
    // so if these tests let redirectUri default to `${mock.url}/` (Bug 2's
    // default), loginAction would try to bind its OWN loopback server to the
    // mock's own port -- EADDRINUSE. Force a non-loopback redirect URI here
    // (mirroring this instance's real site-root registration) so this
    // describe block exercises the manual-paste path throughout, same as
    // before Bug 3 was fixed. See the "loginAction -- loopback capture"
    // describe below for the loopback path itself.
    mock.state.expectedRedirectUri = 'https://example.test/';
  });
  afterEach(async () => {
    await mock.close();
  });

  const env = (secret = 'secret') => ({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: secret,
    OEQ_COLLECTION_UUID: 'c1',
    OEQ_REDIRECT_URI: 'https://example.test/',
  });

  it('prints the authorize URL, attempts to open it, exchanges the entered code, and reports who is logged in', async () => {
    mock.state.validAuthCodes.add('the-code');
    mock.state.currentUser = { username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
    const store = new FileTokenStore(join(dir, 'token.json'));
    const openedUrls: string[] = [];

    const logs = await captureLogs(() =>
      loginAction(env(), {
        tokenStore: store,
        openBrowser: (url) => openedUrls.push(url),
        promptForCode: async () => 'the-code',
      }),
    );

    expect(openedUrls).toHaveLength(1);
    expect(openedUrls[0]).toContain('/oauth/authorise');
    const out = logs.join('\n');
    expect(out).toContain(openedUrls[0]);
    expect(out).toContain('Logged in as jdoe (Jane Doe).');
    expect(out).toContain(`Token cached at ${store.path}.`);
    expect(await store.loadRaw()).not.toBeNull();
  });

  /**
   * "Logged in as guest ( )" was a SUCCESS line. The code exchanged fine, the
   * token was cached, and nothing said the operator could create nothing --
   * because openEQUELLA answers an unauthenticated session as the guest
   * identity rather than refusing it (core/identity.ts).
   */
  it('refuses a guest session rather than printing it as a successful login', async () => {
    mock.state.validAuthCodes.add('the-code');
    mock.state.currentUser = JSON.parse(
      readFileSync('tests/fixtures/api/currentuser-guest.json', 'utf8'),
    );
    const store = new FileTokenStore(join(dir, 'token.json'));

    const err = await captureLogs(() =>
      loginAction(env(), {
        tokenStore: store,
        openBrowser: () => {},
        promptForCode: async () => 'the-code',
      }),
    ).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/guest/i);
    expect((err as Error).message).toMatch(/oeq-upload login/);
  });

  it('continues gracefully (still logs in) when opening the browser fails -- headless/SSH use', async () => {
    mock.state.validAuthCodes.add('the-code');
    const store = new FileTokenStore(join(dir, 'token.json'));

    await expect(
      loginAction(env(), {
        tokenStore: store,
        openBrowser: () => {
          throw new Error('no DISPLAY');
        },
        promptForCode: async () => 'the-code',
      }),
    ).resolves.toBeUndefined();
    expect(await store.loadRaw()).not.toBeNull();
  });

  it('throws a clear error and exchanges nothing when no code is entered', async () => {
    const store = new FileTokenStore(join(dir, 'token.json'));

    await expect(
      loginAction(env(), {
        tokenStore: store,
        openBrowser: () => {},
        promptForCode: async () => '   ',
      }),
    ).rejects.toThrow(/no code/i);
    expect(mock.state.issuedTokens).toHaveLength(0);
    expect(await store.loadRaw()).toBeNull();
  });

  it('never prints the client secret, raw or percent-encoded', async () => {
    const secret = 'a+b/c=d&e';
    mock.state.validAuthCodes.add('the-code');
    const store = new FileTokenStore(join(dir, 'token.json'));

    const logs = await captureLogs(() =>
      loginAction(env(secret), {
        tokenStore: store,
        openBrowser: () => {},
        promptForCode: async () => 'the-code',
      }),
    );

    const out = logs.join('\n');
    const encoded = encodeURIComponent(secret);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(encoded);
  });

  it('warns about the cold-SSO-session client_id(null) failure before opening anything (Bug 1)', async () => {
    mock.state.validAuthCodes.add('the-code');
    const store = new FileTokenStore(join(dir, 'token.json'));

    const logs = await captureLogs(() =>
      loginAction(env(), {
        tokenStore: store,
        openBrowser: () => {},
        promptForCode: async () => 'the-code',
      }),
    );

    const out = logs.join('\n');
    expect(out).toContain('client_id (null)');
    expect(out.toLowerCase()).toContain('sign in');
  });

  it('prints that it is using manual paste when OEQ_REDIRECT_URI is not a loopback address (Bug 3)', async () => {
    mock.state.validAuthCodes.add('the-code');
    const store = new FileTokenStore(join(dir, 'token.json'));

    const logs = await captureLogs(() =>
      loginAction(env(), {
        tokenStore: store,
        openBrowser: () => {},
        promptForCode: async () => 'the-code',
      }),
    );

    const out = logs.join('\n').toLowerCase();
    expect(out).toContain('using manual paste');
    expect(out).toContain('history');
  });

  it('extracts the code when the operator pastes the full URL instead of a bare code (Bug 3b)', async () => {
    mock.state.validAuthCodes.add('abc123');
    const store = new FileTokenStore(join(dir, 'token.json'));

    const logs = await captureLogs(() =>
      loginAction(env(), {
        tokenStore: store,
        openBrowser: () => {},
        promptForCode: async () => 'https://example.test/page/home?code=abc123&state=xyz',
      }),
    );

    expect(logs.join('\n')).toContain('Logged in as');
    expect(await store.loadRaw()).not.toBeNull();
  });
});

describe('loginAction -- loopback capture (Bug 3a)', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer();
  });
  afterEach(async () => {
    await mock.close();
  });

  it('captures the code automatically from a loopback redirect, shuts the server down, and completes the exchange', async () => {
    const port = await getFreePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    mock.state.expectedRedirectUri = redirectUri;
    mock.state.validAuthCodes.add('loop-code');
    mock.state.currentUser = { username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
    const store = new FileTokenStore(join(dir, 'token.json'));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    const loginPromise = loginAction(
      {
        OEQ_BASE_URL: mock.url,
        OEQ_CLIENT_ID: 'good-id',
        OEQ_CLIENT_SECRET: 'secret',
        OEQ_COLLECTION_UUID: 'c1',
        OEQ_REDIRECT_URI: redirectUri,
      },
      { tokenStore: store, openBrowser: () => {} },
    );

    try {
      // Simulates the browser's redirect back to this machine after the
      // operator signs in and authorizes -- loginAction should already be
      // listening for it by the time the server is up.
      await waitForPort(port);
      const res = await fetch(`${redirectUri}?code=loop-code&state=xyz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/close this tab/i);

      await loginPromise;
    } finally {
      console.log = origLog;
    }

    expect(await store.loadRaw()).not.toBeNull();
    const out = logs.join('\n').toLowerCase();
    expect(out).toContain('using loopback capture');
    expect(out).toContain('captured automatically');
    // No promptForCode dep was supplied at all -- if the manual path had run
    // instead, loginAction would have hung waiting on real stdin (or thrown,
    // depending on environment) rather than resolving.

    // The server shut down after capturing the code -- a second request must
    // be refused, not served.
    await expect(fetch(`${redirectUri}?code=other`)).rejects.toThrow();
  });

  it('rejects with the openEQUELLA-reported error when the redirect carries `error=` instead of `code=`', async () => {
    const port = await getFreePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const store = new FileTokenStore(join(dir, 'token.json'));

    const loginPromise = loginAction(
      {
        OEQ_BASE_URL: mock.url,
        OEQ_CLIENT_ID: 'good-id',
        OEQ_CLIENT_SECRET: 'secret',
        OEQ_COLLECTION_UUID: 'c1',
        OEQ_REDIRECT_URI: redirectUri,
      },
      { tokenStore: store, openBrowser: () => {} },
    );

    const assertion = expect(loginPromise).rejects.toThrow(/access_denied/i);
    await waitForPort(port);
    await fetch(`${redirectUri}?error=access_denied`);
    await assertion;
  });
});

describe('extractCode (Bug 3b -- accepts a bare code or a full pasted URL)', () => {
  it('returns a bare code unchanged', () => {
    expect(extractCode('abcd1234')).toBe('abcd1234');
  });

  it('extracts the code parameter from a full pasted URL', () => {
    expect(extractCode('https://content-test.byui.edu/page/home?code=abcd1234&state=xyz')).toBe('abcd1234');
  });

  it('extracts the code parameter from a bare query string', () => {
    expect(extractCode('?code=abcd1234&state=xyz')).toBe('abcd1234');
  });

  it('trims surrounding whitespace before extracting', () => {
    expect(extractCode('  abcd1234  ')).toBe('abcd1234');
  });
});

describe('logoutAction', () => {
  it('removes the cached token', async () => {
    const path = join(dir, 'token.json');
    const store = new FileTokenStore(path);
    await store.save({ accessToken: 'tok', baseUrl: 'https://example.test' });

    await logoutAction({ tokenStore: store });

    expect(await store.loadRaw()).toBeNull();
  });

  it('does not throw when there was nothing to log out of', async () => {
    const store = new FileTokenStore(join(dir, 'never-logged-in.json'));
    await expect(logoutAction({ tokenStore: store })).resolves.toBeUndefined();
  });
});

describe('login and logout in password mode', () => {
  const passwordEnv = {
    OEQ_BASE_URL: 'https://oeq.example.edu',
    OEQ_COLLECTION_UUID: 'c1',
    OEQ_AUTH_MODE: 'password',
    OEQ_USERNAME: 'jsmith',
    OEQ_PASSWORD: 'hunter2',
  };

  it('refuses to run `login`, naming the variables the credentials come from', async () => {
    await expect(loginAction(passwordEnv)).rejects.toThrow(/OEQ_USERNAME/);
  });

  it("points at `check` rather than leaving the operator with nothing to try", async () => {
    await expect(loginAction(passwordEnv)).rejects.toThrow(/check/);
  });

  it('never opens a browser or prompts for a code in password mode', async () => {
    let opened = false;
    await expect(
      loginAction(passwordEnv, {
        openBrowser: () => {
          opened = true;
        },
        promptForCode: () => Promise.reject(new Error('must not prompt')),
      }),
    ).rejects.toThrow();
    expect(opened).toBe(false);
  });

  /**
   * Clearing the local store is a complete logout under OAuth, where the token
   * IS the session. Under password auth the JSESSIONID stays valid on the
   * SERVER until openEQUELLA times it out, so a caller holding a live session
   * must have it ended before this command claims anything.
   */
  it('ends the openEQUELLA session, not just the local token', async () => {
    const store = new FileTokenStore(join(dir, 'password-session.json'));
    const ended: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await logoutAction(
      {
        tokenStore: store,
        auth: {
          logout: async () => {
            ended.push('logout');
            return 'ended' as const;
          },
        },
      },
      passwordEnv,
    );
    log.mockRestore();

    expect(ended).toEqual(['logout']);
    // And the store is still cleared -- an operator who moved over from an
    // OAuth mode can have a stale token file, and stranding it would be worse.
    expect(await store.loadRaw()).toBeNull();
  });

  /** Reads OEQ_AUTH_MODE directly, never through loadConfig: logging out has to
   *  keep working when the config is broken, which is when someone reaches for
   *  it. A config missing OEQ_COLLECTION_UUID would fail loadConfig outright. */
  it('logs out even when the rest of the configuration is unusable', async () => {
    const store = new FileTokenStore(join(dir, 'broken-config.json'));
    await store.save({ accessToken: 'stale', baseUrl: 'https://oeq.example.edu' });
    const ended: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await logoutAction(
      {
        tokenStore: store,
        auth: {
          logout: async () => {
            ended.push('logout');
            return 'ended' as const;
          },
        },
      },
      { OEQ_AUTH_MODE: 'password' },
    );
    log.mockRestore();

    expect(ended).toEqual(['logout']);
    expect(await store.loadRaw()).toBeNull();
  });

  /**
   * THE SAME FALSE CLAIM, ONE LAYER UP. `logout()` never throws, so this
   * command used to print "the openEQUELLA session has been ended on the
   * server" over a PUT that was refused or never arrived. The session outlives
   * the message, and an operator on a shared machine acts on the message.
   */
  it('does not claim the server session ended when the site never confirmed it', async () => {
    const store = new FileTokenStore(join(dir, 'unconfirmed.json'));
    const said: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      said.push(String(m));
    });

    await logoutAction(
      { tokenStore: store, auth: { logout: async () => 'unconfirmed' as const } },
      passwordEnv,
    );
    log.mockRestore();

    expect(said.join(' ')).not.toMatch(/has been ended on the server/);
    expect(said.join(' ')).toMatch(/did not confirm/i);
    // And the local half still happened, exactly as before.
    expect(await store.loadRaw()).toBeNull();
  });

  it('still clears a token left over from an earlier OAuth setup, but says password mode cached none', async () => {
    const store = new FileTokenStore(join(dir, 'stale.json'));
    await store.save({ accessToken: 'stale', baseUrl: 'https://oeq.example.edu' });
    const said: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      said.push(String(m));
    });

    await logoutAction({ tokenStore: store }, passwordEnv);
    log.mockRestore();

    expect(await store.loadRaw()).toBeNull();
    expect(said.join(' ')).toContain('OEQ_USERNAME');
  });
});

describe('checkAction', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer();
  });
  afterEach(async () => {
    await mock.close();
  });

  const env = (overrides: Record<string, string> = {}) => ({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: 'secret',
    OEQ_COLLECTION_UUID: 'c1',
    ...overrides,
  });

  /** A token store already populated via a real exchange against the mock. */
  async function loggedInStore(): Promise<FileTokenStore> {
    mock.state.validAuthCodes.add('good-code');
    const store = new FileTokenStore(join(dir, 'token.json'));
    const auth = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, store);
    await auth.exchangeCode('good-code');
    return store;
  }

  it('prints the exact expected text on full success and exits 0', async () => {
    mock.state.currentUser = { username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
    mock.state.collections.push({
      uuid: 'c1',
      name: 'BYU-Idaho Faculty Content',
      privileges: ['CREATE_ITEM'],
      schemaUuid: 's1',
    });
    // "Everything lines up" now includes a readable schema that declares an
    // item name path -- without one, duplicate detection reports could-not-
    // check for every row, which is not a full success by any reading.
    mock.state.schemas.push({ uuid: 's1', namePath: '/MWDL/title', paths: ['MWDL/title'] });
    const store = await loggedInStore();

    let code = -1;
    const logs = await captureLogs(async () => {
      code = await checkAction(env(), { tokenStore: store });
    });

    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(`OEQ_BASE_URL: ${mock.url}`);
    expect(out).toContain('OEQ_COLLECTION_UUID: c1');
    expect(out).toContain('[PASS] HTTPS:');
    expect(out).toContain('[PASS] Token: present and usable.');
    expect(out).toContain('[PASS] Sign-in method: signed in with OEQ_AUTH_MODE=code');
    expect(out).toContain(
      '[PASS] Identity: logged in as jdoe (Jane Doe). Created items will be owned by this user.',
    );
    expect(out).toContain(
      `[PASS] Collection: 'BYU-Idaho Faculty Content' (c1) exists on ${mock.url}.`,
    );
    expect(out).toContain('[PASS] Collections available: 1 collection(s)');
    expect(out).toContain("[PASS] Permission: CREATE_ITEM confirmed on 'BYU-Idaho Faculty Content'.");
    expect(out).toContain("[PASS] Duplicate detection: existing items will be matched on 'MWDL/title'");
    expect(out).toContain('All checks passed.');
  });

  it('exits 1 and reports FAIL when there is no cached token, naming the actual CLI login command', async () => {
    const store = new FileTokenStore(join(dir, 'never-logged-in.json'));
    let code = -1;
    const logs = await captureLogs(async () => {
      code = await checkAction(env(), { tokenStore: store });
    });
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('[FAIL] Token:');
    // The CLI surface must name the CLI command it can actually be run from.
    expect(out).toContain('oeq-upload login');
    expect(out).not.toContain('oeq_login_url');
  });

  it('exits 1 and reports the failure when the target collection does not exist on this host', async () => {
    const store = await loggedInStore();
    // No collections registered on the mock -- the target does not exist here.
    let code = -1;
    const logs = await captureLogs(async () => {
      code = await checkAction(env(), { tokenStore: store });
    });
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('[FAIL] Collection:');
  });

  it('exits 1 and reports the failure, listing contributable collections, when the target is not contributable', async () => {
    mock.state.collections.push(
      { uuid: 'c1', name: 'View Only', privileges: [] },
      { uuid: 'c2', name: 'Other Collection', privileges: ['CREATE_ITEM'] },
    );
    const store = await loggedInStore();
    let code = -1;
    const logs = await captureLogs(async () => {
      code = await checkAction(env(), { tokenStore: store });
    });
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('[FAIL] Permission:');
    expect(out).toContain('Other Collection');
  });

  it('never prints the client secret, raw or percent-encoded', async () => {
    const secret = 'a+b/c=d&e';
    mock.state.collections.push({ uuid: 'c1', name: 'X', privileges: ['CREATE_ITEM'] });
    const store = await loggedInStore();

    const logs = await captureLogs(async () => {
      await checkAction(env({ OEQ_CLIENT_SECRET: secret }), { tokenStore: store });
    });

    const out = logs.join('\n');
    const encoded = encodeURIComponent(secret);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(encoded);
  });
});

describe('stripBomFromEnvKeys', () => {
  // Windows tools (e.g. PowerShell 5.1's `Set-Content -Encoding utf8`)
  // commonly write a UTF-8 BOM at the start of a file. `process.loadEnvFile()`
  // doesn't strip it, so it ends up prefixed onto the *first* env var's key
  // rather than its value -- this is the exact shape that produces.
  const BOM = '\uFEFF';

  it('re-keys a BOM-prefixed variable without the BOM', () => {
    const fixed = stripBomFromEnvKeys({ [`${BOM}OEQ_BASE_URL`]: 'https://example.test', OTHER: 'x' });
    expect(fixed.OEQ_BASE_URL).toBe('https://example.test');
    expect(fixed.OTHER).toBe('x');
    expect(Object.keys(fixed)).not.toContain(`${BOM}OEQ_BASE_URL`);
  });

  it('returns the same object by reference when there is no BOM-prefixed key', () => {
    const env = { OEQ_BASE_URL: 'https://example.test' };
    expect(stripBomFromEnvKeys(env)).toBe(env);
  });

  it('lets loadConfig succeed against an env object whose first key was BOM-prefixed', () => {
    // This is the actual bug: loadConfig(), unfixed, reports OEQ_BASE_URL as
    // "missing" even though the value is right there, because it's really
    // filed under `\uFEFFOEQ_BASE_URL`.
    const raw = {
      [`${BOM}OEQ_BASE_URL`]: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
    };
    expect(() => loadConfig(raw)).toThrow(/OEQ_BASE_URL/);

    const fixed = stripBomFromEnvKeys(raw);
    const cfg = loadConfig(fixed);
    expect(cfg.baseUrl).toBe('https://example.test');
  });

  it('handles a BOM-prefixed key alongside normal ones, leaving the rest untouched', () => {
    const fixed = stripBomFromEnvKeys({
      [`${BOM}OEQ_BASE_URL`]: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
    });
    expect(Object.keys(fixed).sort()).toEqual(['OEQ_BASE_URL', 'OEQ_CLIENT_ID', 'OEQ_CLIENT_SECRET']);
  });
});

/**
 * `oeq-upload login` opened a URL that openEQUELLA then rejected with
 * "No OAuth client can be found with the supplied client_id (null) and
 * redirect_uri (null)".
 *
 * The cause was not, as the login command's own doc comment guessed, a cold
 * SSO session dropping the query string. It was `cmd /c start "" <url>`:
 * cmd.exe treats `&` as a command separator, so the authorize URL was cut at
 * the first one and only `?response_type=code` ever reached the browser. Both
 * parameters really were absent.
 */
describe('browserCommand', () => {
  const url = 'https://content.byui.edu/oauth/authorise?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fx';

  it('does not hand a Windows shell a string it will split on &', () => {
    const { command, args } = browserCommand('win32', url);
    expect(command).not.toBe('cmd');
    expect(args).toContain(url);
  });

  it('passes the whole URL as one argument on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const { args } = browserCommand(platform, url);
      expect(args.filter((a) => a.includes('client_id=abc'))).toHaveLength(1);
      expect(args.some((a) => a.includes('redirect_uri='))).toBe(true);
    }
  });

  it('uses the platform opener on mac and linux', () => {
    expect(browserCommand('darwin', url).command).toBe('open');
    expect(browserCommand('linux', url).command).toBe('xdg-open');
  });
});
