import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Every front end must ask `createAuthProvider` for its auth rather than
 * constructing one itself.
 *
 * Five call sites had each hand-rolled `new AuthorizationCodeAuth(...)`, so
 * `OEQ_AUTH_MODE=password` silently produced an OAuth provider with an empty
 * client id -- and openEQUELLA answers that with "No OAuth client can be found
 * with the supplied client_id (null)", advice that is actively misleading for
 * an institution that never had an OAuth client to configure.
 *
 * WHY A WRAPPING SPY AND NOT AN END-TO-END TEST: `UsernamePasswordAuth`
 * requires https (instanceUrl.ts), so it cannot be pointed at the http mock
 * server the rest of the suite uses. The spy calls the REAL
 * `createAuthProvider` and records what it built -- so the assertion is on a
 * genuine provider, built by real config code from the front end's own
 * `Config` -- then hands back a stub so nothing downstream reaches the
 * network. Reverting any call site to a direct constructor makes `built`
 * empty and the matching test red.
 */
const hoisted = vi.hoisted(() => ({
  built: [] as unknown[],
  stub: {
    getToken: () => Promise.reject(new Error('stubbed provider -- no network in this test')),
    authHeader: () => Promise.reject(new Error('stubbed provider -- no network in this test')),
    invalidate: () => {},
  },
}));

vi.mock('../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/config.js')>();
  return {
    ...actual,
    createAuthProvider: (...args: Parameters<typeof actual.createAuthProvider>) => {
      hoisted.built.push(actual.createAuthProvider(...args));
      return hoisted.stub;
    },
  };
});

const { UsernamePasswordAuth } = await import('../src/core/passwordAuth.js');
const { loadConfig } = await import('../src/core/config.js');
const { checkAction } = await import('../src/cli/index.js');
const { checkTool, planTool } = await import('../src/mcp/index.js');
const { buildAuth } = await import('../src/desktop/session.js');
const { FileTokenStore } = await import('../src/core/tokenStore.js');

const passwordEnv = {
  OEQ_BASE_URL: 'https://oeq.example.edu',
  OEQ_COLLECTION_UUID: 'c1',
  OEQ_AUTH_MODE: 'password',
  OEQ_USERNAME: 'jsmith',
  OEQ_PASSWORD: 'hunter2',
};

let dir: string;
beforeEach(async () => {
  hoisted.built.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'oeq-auth-routing-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('password mode reaches every front end', () => {
  it('CLI `check` builds a UsernamePasswordAuth', async () => {
    // Returns 1: the stubbed getToken fails the Token check, which is the
    // point -- no network, and the provider it BUILT is what matters.
    await checkAction(passwordEnv);
    expect(hoisted.built).toHaveLength(1);
    expect(hoisted.built[0]).toBeInstanceOf(UsernamePasswordAuth);
  });

  it('MCP oeq_check builds a UsernamePasswordAuth', async () => {
    await checkTool(passwordEnv);
    expect(hoisted.built).toHaveLength(1);
    expect(hoisted.built[0]).toBeInstanceOf(UsernamePasswordAuth);
  });

  it('the desktop builds a UsernamePasswordAuth', async () => {
    buildAuth(loadConfig(passwordEnv), new FileTokenStore(join(dir, 'token.json')));
    expect(hoisted.built).toHaveLength(1);
    expect(hoisted.built[0]).toBeInstanceOf(UsernamePasswordAuth);
  });

  it("MCP oeq_plan's duplicate check builds a UsernamePasswordAuth", async () => {
    const sheetPath = join(dir, 'batch.csv');
    await writeFile(
      sheetPath,
      ['attachment name,MWDL/identifier,MWDL/title', 'clip1.mp4,test-id-001,Test Clip One'].join('\n'),
    );
    await writeFile(join(dir, 'clip1.mp4'), '1');

    const result = await planTool(
      { sheet: sheetPath, filesDir: dir, manifestPath: join(dir, 'job.json') },
      passwordEnv,
    );

    expect(result.isError).toBeFalsy();
    expect(hoisted.built).toHaveLength(1);
    expect(hoisted.built[0]).toBeInstanceOf(UsernamePasswordAuth);
  });

  it('names OEQ_USERNAME/OEQ_PASSWORD, not the OAuth client, when password credentials are missing', async () => {
    const sheetPath = join(dir, 'batch.csv');
    await writeFile(
      sheetPath,
      ['attachment name,MWDL/identifier,MWDL/title', 'clip1.mp4,test-id-001,Test Clip One'].join('\n'),
    );
    await writeFile(join(dir, 'clip1.mp4'), '1');

    const result = await planTool(
      { sheet: sheetPath, filesDir: dir, manifestPath: join(dir, 'job.json') },
      // Collection set, credentials deliberately absent: the point of this
      // test is WHICH credential variables get named, so the config must be
      // complete apart from them.
      { OEQ_BASE_URL: 'https://oeq.example.edu', OEQ_COLLECTION_UUID: 'c1', OEQ_AUTH_MODE: 'password' },
    );

    const out = result.content.map((c) => c.text).join('\n');
    expect(out).toContain('OEQ_USERNAME/OEQ_PASSWORD');
    expect(out).not.toContain('OEQ_CLIENT_ID');
  });
});
