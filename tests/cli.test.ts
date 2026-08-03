import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planAction,
  runAction,
  statusAction,
  retryAction,
  loginAction,
  logoutAction,
  checkAction,
  stripBomFromEnvKeys,
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

describe('loginAction', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer();
  });
  afterEach(async () => {
    await mock.close();
  });

  const env = (secret = 'secret') => ({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: secret,
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
    });
    const store = await loggedInStore();

    let code = -1;
    const logs = await captureLogs(async () => {
      code = await checkAction(env(), { tokenStore: store });
    });

    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(`OEQ_BASE_URL: ${mock.url}`);
    expect(out).toContain('OEQ_COLLECTION_UUID: c1');
    expect(out).toContain('[PASS] Token: present and usable.');
    expect(out).toContain(
      '[PASS] Identity: logged in as jdoe (Jane Doe). Created items will be owned by this user.',
    );
    expect(out).toContain(
      `[PASS] Collection: 'BYU-Idaho Faculty Content' (c1) exists on ${mock.url}.`,
    );
    expect(out).toContain("[PASS] Permission: CREATE_ITEM confirmed on 'BYU-Idaho Faculty Content'.");
    expect(out).toContain('All checks passed.');
  });

  it('exits 1 and reports FAIL when there is no cached token', async () => {
    const store = new FileTokenStore(join(dir, 'never-logged-in.json'));
    let code = -1;
    const logs = await captureLogs(async () => {
      code = await checkAction(env(), { tokenStore: store });
    });
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('[FAIL] Token:');
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
