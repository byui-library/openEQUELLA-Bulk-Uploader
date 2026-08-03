import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runPreflight } from '../src/core/preflight.js';
import { loadConfig, type Config } from '../src/core/config.js';
import { AuthorizationCodeAuth } from '../src/core/authCode.js';
import { FileTokenStore } from '../src/core/tokenStore.js';
import { OeqClient } from '../src/core/client.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

let mock: MockServer;
let dir: string;

beforeEach(async () => {
  mock = await startMockServer();
  dir = await mkdtemp(join(tmpdir(), 'oeq-preflight-'));
});
afterEach(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

function cfgFor(mock: MockServer, collectionUuid: string): Config {
  return loadConfig({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: 'secret',
    OEQ_COLLECTION_UUID: collectionUuid,
  });
}

async function loggedInAuth(cfg: Config): Promise<AuthorizationCodeAuth> {
  mock.state.validAuthCodes.add('good-code');
  const auth = new AuthorizationCodeAuth(
    cfg.baseUrl,
    cfg.clientId,
    cfg.clientSecret,
    cfg.redirectUri,
    new FileTokenStore(join(dir, 'token.json')),
  );
  await auth.exchangeCode('good-code');
  return auth;
}

describe('runPreflight', () => {
  it('passes all four checks when everything lines up', async () => {
    const cfg = cfgFor(mock, 'c1');
    mock.state.collections.push({ uuid: 'c1', name: 'Faculty Content', privileges: ['CREATE_ITEM'] });
    const auth = await loggedInAuth(cfg);
    const client = new OeqClient(cfg.baseUrl, auth);

    const result = await runPreflight(cfg, auth, client);

    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.label)).toEqual(['Token', 'Identity', 'Collection', 'Permission']);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  it('stops after Token and does not run the other three checks when there is no token', async () => {
    const cfg = cfgFor(mock, 'c1');
    const auth = new AuthorizationCodeAuth(
      cfg.baseUrl,
      cfg.clientId,
      cfg.clientSecret,
      cfg.redirectUri,
      new FileTokenStore(join(dir, 'token.json')),
    );
    const client = new OeqClient(cfg.baseUrl, auth);

    const result = await runPreflight(cfg, auth, client);

    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ label: 'Token', pass: false });
    expect(result.checks[0]!.message).toMatch(/oeq-upload login/);
  });

  it('substitutes a caller-supplied loginHint for the default CLI instruction', async () => {
    const cfg = cfgFor(mock, 'c1');
    const auth = new AuthorizationCodeAuth(
      cfg.baseUrl,
      cfg.clientId,
      cfg.clientSecret,
      cfg.redirectUri,
      new FileTokenStore(join(dir, 'token.json')),
    );
    const client = new OeqClient(cfg.baseUrl, auth);

    const result = await runPreflight(cfg, auth, client, 'Call the oeq_login_url tool');

    expect(result.checks[0]!.message).toContain('Call the oeq_login_url tool');
    // The default CLI instruction must be gone entirely, not just appended to.
    expect(result.checks[0]!.message).not.toMatch(/oeq-upload login/);
    // The "why" (no cached token, which host) is still present -- only the
    // actionable tail was swapped.
    expect(result.checks[0]!.message).toContain('No cached OAuth token');
  });

  it('reports a failure when the target collection does not exist on this host', async () => {
    const cfg = cfgFor(mock, 'does-not-exist');
    // No collections registered on the mock at all.
    const auth = await loggedInAuth(cfg);
    const client = new OeqClient(cfg.baseUrl, auth);

    const result = await runPreflight(cfg, auth, client);

    expect(result.ok).toBe(false);
    const collectionCheck = result.checks.find((c) => c.label === 'Collection')!;
    expect(collectionCheck.pass).toBe(false);
    expect(collectionCheck.message).toMatch(/does not exist/i);
    expect(collectionCheck.message).toMatch(/OEQ_BASE_URL/);
  });

  it('reports a failure, and lists contributable collections, when the target is not contributable', async () => {
    const cfg = cfgFor(mock, 'c1');
    mock.state.collections.push(
      { uuid: 'c1', name: 'View Only Collection', privileges: [] }, // exists, but no CREATE_ITEM
      { uuid: 'c2', name: 'Other Collection', privileges: ['CREATE_ITEM'] },
    );
    const auth = await loggedInAuth(cfg);
    const client = new OeqClient(cfg.baseUrl, auth);

    const result = await runPreflight(cfg, auth, client);

    expect(result.ok).toBe(false);
    const collectionCheck = result.checks.find((c) => c.label === 'Collection')!;
    expect(collectionCheck.pass).toBe(true); // it exists...
    const permissionCheck = result.checks.find((c) => c.label === 'Permission')!;
    expect(permissionCheck.pass).toBe(false); // ...just not contributable
    expect(permissionCheck.message).toContain('Other Collection');
    expect(permissionCheck.message).toContain('c2');
  });

  it('reports a failure when the user cannot contribute to any collection at all', async () => {
    const cfg = cfgFor(mock, 'c1');
    mock.state.collections.push({ uuid: 'c1', name: 'View Only Collection', privileges: [] });
    const auth = await loggedInAuth(cfg);
    const client = new OeqClient(cfg.baseUrl, auth);

    const result = await runPreflight(cfg, auth, client);

    const permissionCheck = result.checks.find((c) => c.label === 'Permission')!;
    expect(permissionCheck.pass).toBe(false);
    expect(permissionCheck.message).toMatch(/not confirmed on any collection/i);
  });
});
