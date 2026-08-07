import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSchemaPaths,
  validateSheetTool,
  planTool,
  startJobTool,
  jobStatusTool,
  retryFailedTool,
  loginUrlTool,
  loginCompleteTool,
  checkTool,
} from '../src/mcp/index.js';
import { acquireLock, releaseLock } from '../src/core/lock.js';
import { saveManifest, loadManifest } from '../src/core/state.js';
import { AuthorizationCodeAuth } from '../src/core/authCode.js';
import { FileTokenStore } from '../src/core/tokenStore.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';
import type { Manifest } from '../src/core/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-mcp-'));
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

const configEnv = () => ({
  OEQ_BASE_URL: 'https://example.test',
  OEQ_CLIENT_ID: 'test-client-id',
  OEQ_CLIENT_SECRET: 'super-secret-value',
});

function textOf(result: { content: Array<{ type: 'text'; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

/** A minimal, generic (not student) batch with an MWDL/identifier column,
 *  so preflightDuplicates has something to check. */
async function writeIdentifierSheet(sheetDir: string): Promise<string> {
  const sheetPath = join(sheetDir, 'batch.csv');
  await writeFile(
    sheetPath,
    [
      'attachment name,MWDL/identifier,MWDL/title',
      'clip1.mp4,test-id-001,Test Clip One',
      'clip2.mp4,test-id-002,Test Clip Two',
    ].join('\n'),
  );
  await writeFile(join(sheetDir, 'clip1.mp4'), '1');
  await writeFile(join(sheetDir, 'clip2.mp4'), '2');
  return sheetPath;
}

describe('oeq_list_schema_paths', () => {
  it('returns matching xpaths from the real schema for a filter', async () => {
    const result = await listSchemaPaths({ filter: 'creator' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('MWDL/creators/creator');
  });

  it('falls back to nearest-match suggestions when nothing contains the filter literally', async () => {
    const result = await listSchemaPaths({ filter: 'MWDL/creator' });
    // Not an exact substring hit against any real xpath as typed, but should
    // still surface the near match via suggest().
    expect(textOf(result)).toContain('MWDL/creators/creator');
  });
});

describe('oeq_validate_sheet', () => {
  it('reports an invalid header with suggestion text', async () => {
    const sheetPath = join(dir, 'batch.csv');
    // 'MWDL/Title' (wrong case) is not a valid xpath -- only 'MWDL/title' is
    // -- so this should come back invalid with that as the suggestion.
    await writeFile(
      sheetPath,
      [
        'attachment name,MWDL/Title,MWDL/identifier',
        'clip.mp4,Example Title,clip-001',
      ].join('\n'),
    );

    const result = await validateSheetTool({ sheet: sheetPath });
    const out = textOf(result);
    expect(out).toContain("INVALID 'MWDL/Title'");
    expect(out).toContain('did you mean');
    expect(out).toContain('MWDL/title');
  });

  it('reports all headers valid for a clean sheet', async () => {
    const result = await validateSheetTool({ sheet: 'tests/fixtures/sample-batch.csv' });
    expect(textOf(result)).toContain('All headers are valid.');
    expect(result.isError).toBeFalsy();
  });
});

describe('oeq_plan and a live lock', () => {
  it('refuses, naming the owning pid, and writes nothing while a live lock is held', async () => {
    const manifestPath = join(dir, 'job.json');
    // acquireLock() records this test process's own pid, which is
    // definitionally alive -- the live lock the task requires we test against.
    await acquireLock(manifestPath);
    try {
      const result = await planTool(
        { sheet: 'tests/fixtures/sample-batch.csv', filesDir: dir, manifestPath },
        configEnv(),
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(String(process.pid));
      // No writes at all: the manifest must not have been created.
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      await releaseLock(manifestPath);
    }
  });

  it('never leaks OEQ_CLIENT_SECRET into its output, even on error', async () => {
    const manifestPath = join(dir, 'job.json');
    const result = await planTool(
      { sheet: 'does-not-exist.csv', filesDir: dir, manifestPath },
      configEnv(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('super-secret-value');
  });

  it('never leaks OEQ_CLIENT_SECRET even when the config itself is invalid (missing OEQ_BASE_URL)', async () => {
    const manifestPath = join(dir, 'job.json');
    const result = await planTool(
      { sheet: 'tests/fixtures/sample-batch.csv', filesDir: dir, manifestPath },
      // OEQ_BASE_URL deliberately omitted -- loadConfig throws here, and its
      // error text must not carry OEQ_CLIENT_SECRET even though the secret
      // was present in the environment this call was made with.
      { OEQ_CLIENT_ID: 'id', OEQ_CLIENT_SECRET: 'super-secret-value' },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('super-secret-value');
  });

  it('plans a manifest from the sample batch when unlocked', async () => {
    // Real filenames from tests/fixtures/sample-batch.csv's 'attachment name'
    // column -- not invented student data, just the fixture's own values.
    await writeFile(join(dir, 'Aster, Juniper 010125.MP4'), 'a');
    await writeFile(join(dir, 'Birch ,Rowan 010125.MP4'), 'b');
    await writeFile(join(dir, 'Cedar (Thorn), Wren 010225.mp4'), 'c');

    const manifestPath = join(dir, 'job.json');
    const result = await planTool(
      // skipDuplicateCheck: true -- this test is about the file-matching/
      // manifest-writing wiring, not the duplicate check, and configEnv()'s
      // baseUrl isn't a real server; the duplicate-check behavior itself is
      // covered by the 'oeq_plan duplicate pre-flight' tests below.
      { sheet: 'tests/fixtures/sample-batch.csv', filesDir: dir, manifestPath, skipDuplicateCheck: true },
      configEnv(),
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Planned 3 item(s)');

    const saved = await loadManifest(manifestPath);
    expect(saved.entries).toHaveLength(3);
    expect(saved.itemState).toBe('draft');
  });

  it('rejects an invalid itemState before touching the filesystem', async () => {
    const manifestPath = join(dir, 'job.json');
    const result = await planTool(
      {
        sheet: 'tests/fixtures/sample-batch.csv',
        filesDir: dir,
        manifestPath,
        itemState: 'published-live-oops',
      },
      configEnv(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("must be 'draft' or 'published'");
    expect(existsSync(manifestPath)).toBe(false);
  });
});

describe('oeq_plan duplicate pre-flight', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer();
  });
  afterEach(async () => {
    await mock.close();
  });

  const mockEnv = () => ({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: 'secret',
  });

  it('does not attempt a network call when skipDuplicateCheck is true', async () => {
    const sheetPath = await writeIdentifierSheet(dir);
    const manifestPath = join(dir, 'job.json');

    const result = await planTool(
      { sheet: sheetPath, filesDir: dir, manifestPath, skipDuplicateCheck: true },
      mockEnv(),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain('Duplicate check');
    // The strongest proof no network call was made: the mock server never
    // even issued a token.
    expect(mock.state.issuedTokens).toHaveLength(0);
  });

  it('surfaces a warning for a known existing identifier, matching planAction', async () => {
    mock.state.existingIdentifiers = ['test-id-001'];
    const sheetPath = await writeIdentifierSheet(dir);
    const manifestPath = join(dir, 'job.json');

    const result = await planTool({ sheet: sheetPath, filesDir: dir, manifestPath }, mockEnv());

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('test-id-001');
    expect(mock.state.issuedTokens.length).toBeGreaterThan(0);

    // The warning is persisted into the manifest itself, not just printed --
    // mirroring planAction, so a later oeq_job_status sees it too.
    const saved = await loadManifest(manifestPath);
    expect(saved.warnings.join(' ')).toContain('test-id-001');
  });

  it('still returns a successful plan when credentials are absent, skipping the duplicate check with a warning', async () => {
    const sheetPath = await writeIdentifierSheet(dir);
    const manifestPath = join(dir, 'job.json');

    // OEQ_BASE_URL is a real, reachable mock server here specifically to
    // prove the *absence of credentials* is what skips the check -- if the
    // guard were instead accidentally gated on network reachability, this
    // would behave differently from the true "no server at all" case.
    const result = await planTool(
      { sheet: sheetPath, filesDir: dir, manifestPath },
      { OEQ_BASE_URL: mock.url },
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Duplicate check skipped');
    expect(mock.state.issuedTokens).toHaveLength(0);

    // Not a landmine: the saved manifest is structurally complete (real
    // baseUrl, non-empty collectionUuid/schemaUuid from loadConfig's own
    // defaults) and loads back cleanly -- proving planning without
    // credentials doesn't silently corrupt anything for later steps.
    const saved = await loadManifest(manifestPath);
    expect(saved.entries).toHaveLength(2);
    expect(saved.baseUrl).toBe(mock.url);
    expect(saved.collectionUuid.length).toBeGreaterThan(0);
    expect(saved.schemaUuid.length).toBeGreaterThan(0);
  });

  it('reports a near-certain duplicate finding when an existing item already holds the row\'s file', async () => {
    mock.state.existingItems = [
      { uuid: 'existing-1', version: 1, title: 'Test Clip One', attachmentNames: ['clip1.mp4'] },
    ];
    const sheetPath = await writeIdentifierSheet(dir);
    const manifestPath = join(dir, 'job.json');

    const result = await planTool({ sheet: sheetPath, filesDir: dir, manifestPath }, mockEnv());

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('near-certain');
    expect(textOf(result)).toContain('clip1.mp4');
  });
});

describe('oeq_retry_failed and a live lock', () => {
  const failedManifest = () =>
    manifest({
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

  it('refuses, naming the owning pid, and writes nothing while a live lock is held', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, failedManifest());
    await acquireLock(manifestPath);
    try {
      const result = await retryFailedTool({ manifestPath });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(String(process.pid));

      const stillLocked = await loadManifest(manifestPath);
      expect(stillLocked.entries[0]!.status).toBe('failed');
      expect(stillLocked.entries[0]!.attempts).toBe(3);
    } finally {
      await releaseLock(manifestPath);
    }
  });

  it('resets failed entries to pending when no lock is held', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, failedManifest());

    const result = await retryFailedTool({ manifestPath });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Reset 1 failed entry');

    const after = await loadManifest(manifestPath);
    expect(after.entries[0]!.status).toBe('pending');
    expect(after.entries[0]!.attempts).toBe(0);
    expect(after.entries[0]!.error).toBeUndefined();
  });
});

describe('oeq_start_job and a live lock', () => {
  it('refuses to spawn a second runner while a live lock is held', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, manifest());
    await acquireLock(manifestPath);
    try {
      const result = await startJobTool({ manifestPath });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(String(process.pid));
    } finally {
      await releaseLock(manifestPath);
    }
  });

  it('fails clearly, without spawning, when the CLI entry point cannot be found', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, manifest());

    const result = await startJobTool(
      { manifestPath },
      { entryPoint: join(dir, 'does-not-exist', 'index.js') },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('npm run build');
  });

  it('spawns the runner detached and returns immediately when unlocked and the entry exists', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, manifest());

    // A minimal stand-in CLI entry point: exits immediately, proving only
    // that startJobTool actually spawns and detaches, not the real runner's
    // behavior (that's covered by cli.test.ts / runner.test.ts).
    const fakeEntry = join(dir, 'fake-cli.js');
    await writeFile(fakeEntry, 'process.exit(0);\n');

    const result = await startJobTool(
      { manifestPath, logPath: join(dir, 'job.log') },
      { entryPoint: fakeEntry },
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/Started runner pid=\d+/);
  });
});

describe('oeq_job_status', () => {
  it('works while locked and names the lock holder', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(
      manifestPath,
      manifest({
        entries: [
          {
            rowNumber: 2,
            filePath: join(dir, 'a.mp4'),
            fileName: 'a.mp4',
            metadata: {},
            status: 'created',
            attempts: 1,
            itemUuid: 'item-1',
          },
          {
            rowNumber: 3,
            filePath: join(dir, 'b.mp4'),
            fileName: 'b.mp4',
            metadata: {},
            status: 'failed',
            attempts: 2,
            error: 'boom',
          },
        ],
      }),
    );
    await acquireLock(manifestPath);
    try {
      const result = await jobStatusTool({ manifestPath });
      expect(result.isError).toBeFalsy();
      const out = textOf(result);
      expect(out).toContain('"created":1');
      expect(out).toContain('"failed":1');
      expect(out).toContain(`Lock held by pid ${process.pid}`);
    } finally {
      await releaseLock(manifestPath);
    }
  });

  it('reports "No active lock." when unlocked', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, manifest());
    const result = await jobStatusTool({ manifestPath });
    expect(textOf(result)).toContain('No active lock.');
  });
});

describe('oeq_login_url / oeq_login_complete / oeq_check', () => {
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

  /** A token store already populated via a real exchange against the mock -- mirrors cli.test.ts. */
  async function loggedInStore(): Promise<FileTokenStore> {
    mock.state.validAuthCodes.add('good-code');
    const store = new FileTokenStore(join(dir, 'token.json'));
    const auth = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, store);
    await auth.exchangeCode('good-code');
    return store;
  }

  describe('oeq_login_url', () => {
    it('returns the authorize URL with instructions on where to find the code', async () => {
      const result = await loginUrlTool(env());
      expect(result.isError).toBeFalsy();
      const out = textOf(result);
      expect(out).toContain(`${mock.url}/oauth/authorise`);
      expect(out).toContain('response_type=code');
      expect(out.toLowerCase()).toContain('code');
      expect(out.toLowerCase()).toContain('oeq_login_complete');
    });

    it('never leaks the client secret, even on a config error', async () => {
      const result = await loginUrlTool({ OEQ_CLIENT_ID: 'id', OEQ_CLIENT_SECRET: 'super-secret-value' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toContain('super-secret-value');
    });
  });

  describe('oeq_login_complete', () => {
    beforeEach(() => {
      // loginCompleteTool builds its AuthorizationCodeAuth from cfg.redirectUri,
      // which env() below never overrides -- so loadConfig() defaults it to
      // `${mock.url}/` (Bug 2 -- see config.ts). Match the mock's registered
      // client to that same value.
      mock.state.expectedRedirectUri = `${mock.url}/`;
    });

    it('exchanges the code, caches the token, and reports who is logged in', async () => {
      mock.state.validAuthCodes.add('the-code');
      mock.state.currentUser = { username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
      const tokenStore = new FileTokenStore(join(dir, 'token.json'));

      const result = await loginCompleteTool({ code: 'the-code' }, env(), { tokenStore });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe('Logged in as jdoe (Jane Doe).');
      expect(await tokenStore.loadRaw()).not.toBeNull();
    });

    it('reports a clear error for an invalid or already-used code', async () => {
      const tokenStore = new FileTokenStore(join(dir, 'token.json'));
      const result = await loginCompleteTool({ code: 'never-issued' }, env(), { tokenStore });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/invalid|expired/i);
    });

    it('never leaks the client secret, raw or percent-encoded', async () => {
      const secret = 'a+b/c=d&e';
      mock.state.validAuthCodes.add('the-code');
      const tokenStore = new FileTokenStore(join(dir, 'token.json'));
      const result = await loginCompleteTool({ code: 'the-code' }, env(secret), { tokenStore });
      const out = textOf(result);
      const encoded = encodeURIComponent(secret);
      expect(out).not.toContain(secret);
      expect(out).not.toContain(encoded);
    });
  });

  describe('oeq_check', () => {
    it('mirrors the CLI: prints the same four PASS lines and succeeds when everything lines up', async () => {
      mock.state.currentUser = { username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
      mock.state.collections.push({
        uuid: 'bb348ab1-7a81-4e37-8ef7-adc095ade4f9',
        name: 'BYU-Idaho Faculty Content',
        privileges: ['CREATE_ITEM'],
      });
      const tokenStore = await loggedInStore();

      const result = await checkTool(env(), { tokenStore });

      expect(result.isError).toBeFalsy();
      const out = textOf(result);
      expect(out).toContain(`OEQ_BASE_URL: ${mock.url}`);
      expect(out).toContain('[PASS] Token: present and usable.');
      expect(out).toContain('[PASS] Identity: logged in as jdoe (Jane Doe)');
      expect(out).toContain("[PASS] Collection: 'BYU-Idaho Faculty Content'");
      expect(out).toContain("[PASS] Permission: CREATE_ITEM confirmed on 'BYU-Idaho Faculty Content'.");
      expect(out).toContain('All checks passed.');
    });

    it('reports isError and FAIL when there is no cached token, naming the MCP login tools -- not the CLI command', async () => {
      const tokenStore = new FileTokenStore(join(dir, 'never-logged-in.json'));
      const result = await checkTool(env(), { tokenStore });
      expect(result.isError).toBe(true);
      const out = textOf(result);
      expect(out).toContain('[FAIL] Token:');
      // The MCP surface has no shell to run `oeq-upload login` in -- it must
      // point at its own tools instead.
      expect(out).toContain('oeq_login_url');
      expect(out).toContain('oeq_login_complete');
      expect(out).not.toContain('oeq-upload login');
    });

    it('reports isError and FAIL when the target collection does not exist on this host', async () => {
      const tokenStore = await loggedInStore();
      // No collections registered on the mock.
      const result = await checkTool(env(), { tokenStore });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('[FAIL] Collection:');
    });

    it('reports isError and FAIL, listing contributable collections, when the target is not contributable', async () => {
      mock.state.collections.push(
        { uuid: 'bb348ab1-7a81-4e37-8ef7-adc095ade4f9', name: 'View Only', privileges: [] },
        { uuid: 'c2', name: 'Other Collection', privileges: ['CREATE_ITEM'] },
      );
      const tokenStore = await loggedInStore();
      const result = await checkTool(env(), { tokenStore });
      expect(result.isError).toBe(true);
      const out = textOf(result);
      expect(out).toContain('[FAIL] Permission:');
      expect(out).toContain('Other Collection');
    });

    it('never leaks the client secret, raw or percent-encoded', async () => {
      const secret = 'a+b/c=d&e';
      mock.state.collections.push({
        uuid: 'bb348ab1-7a81-4e37-8ef7-adc095ade4f9',
        name: 'X',
        privileges: ['CREATE_ITEM'],
      });
      const tokenStore = await loggedInStore();
      const result = await checkTool(env(secret), { tokenStore });
      const out = textOf(result);
      const encoded = encodeURIComponent(secret);
      expect(out).not.toContain(secret);
      expect(out).not.toContain(encoded);
    });
  });
});
