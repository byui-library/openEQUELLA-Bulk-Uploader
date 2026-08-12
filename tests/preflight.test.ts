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
  // cfgFor() below never sets OEQ_REDIRECT_URI, so loadConfig() defaults it
  // to `${mock.url}/` (Bug 2 -- see config.ts). Match the mock's registered
  // client to that same value so exchangeCode() in loggedInAuth() succeeds;
  // these tests exercise runPreflight(), not redirect_uri matching itself.
  mock.state.expectedRedirectUri = `${mock.url}/`;
  dir = await mkdtemp(join(tmpdir(), 'oeq-preflight-'));
});
afterEach(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

function cfgFor(mock: MockServer, collectionUuid: string, attachmentUuidPath?: string): Config {
  return loadConfig({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: 'secret',
    OEQ_COLLECTION_UUID: collectionUuid,
    OEQ_ATTACHMENT_UUID_PATH: attachmentUuidPath,
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
  it('passes every check when everything lines up', async () => {
    const cfg = cfgFor(mock, 'c1');
    mock.state.collections.push({ uuid: 'c1', name: 'Faculty Content', privileges: ['CREATE_ITEM'] });
    const auth = await loggedInAuth(cfg);
    const client = new OeqClient(cfg.baseUrl, auth);

    const result = await runPreflight(cfg, auth, client);

    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.label)).toEqual([
      'Token',
      'Identity',
      'Collection',
      'Permission',
      'Attachment field',
    ]);
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

  /**
   * The attachment-uuid field is written on EVERY item created, so a path that
   * does not exist in the collection's schema is worth naming before a batch
   * runs rather than after. Unset is a legitimate configuration -- most
   * schemas declare no such node -- and must read as one, not as a warning.
   */
  describe('the attachment-uuid field check', () => {
    const contributable = { uuid: 'c1', name: 'Faculty Content', privileges: ['CREATE_ITEM'] };

    it('says plainly that nothing will be written when no path is configured', async () => {
      const cfg = cfgFor(mock, 'c1');
      mock.state.collections.push(contributable);
      const auth = await loggedInAuth(cfg);
      const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

      const check = result.checks.find((c) => c.label === 'Attachment field')!;
      expect(check.pass).toBe(true);
      expect(check.message).toMatch(/OEQ_ATTACHMENT_UUID_PATH/);
      expect(check.message).toMatch(/not set/i);
      // It must not read as a defect: the attachment itself is unaffected.
      expect(check.message).toMatch(/attachment itself/i);
    });

    it('confirms a configured path that the collection\'s schema really declares', async () => {
      const cfg = cfgFor(mock, 'c1', 'Local/attachments/attachment');
      mock.state.collections.push({ ...contributable, schemaUuid: 's1' });
      mock.state.schemas.push({
        uuid: 's1',
        namePath: '/MWDL/title',
        paths: ['MWDL/title', 'Local/attachments/attachment'],
      });
      const auth = await loggedInAuth(cfg);
      const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

      const check = result.checks.find((c) => c.label === 'Attachment field')!;
      expect(check.pass).toBe(true);
      expect(check.message).toContain('Local/attachments/attachment');
      expect(result.ok).toBe(true);
    });

    it('fails, naming the path and the variable, when the schema has no such node', async () => {
      const cfg = cfgFor(mock, 'c1', 'Elsewhere/attachments/attachment');
      mock.state.collections.push({ ...contributable, schemaUuid: 's1' });
      mock.state.schemas.push({ uuid: 's1', namePath: '/MWDL/title', paths: ['MWDL/title'] });
      const auth = await loggedInAuth(cfg);
      const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

      const check = result.checks.find((c) => c.label === 'Attachment field')!;
      expect(check.pass).toBe(false);
      expect(check.message).toContain('Elsewhere/attachments/attachment');
      expect(check.message).toContain('OEQ_ATTACHMENT_UUID_PATH');
      expect(result.ok).toBe(false);
    });

    /**
     * "Could not check" is never reported as clean anywhere else in this tool
     * and must not be here either -- the operator opted into writing this
     * field, so an unverifiable path is a thing to resolve, not to assume.
     */
    it('fails rather than passing quietly when the schema cannot be read', async () => {
      const cfg = cfgFor(mock, 'c1', 'Local/attachments/attachment');
      // Collection exists and is contributable, but declares no schema.
      mock.state.collections.push(contributable);
      const auth = await loggedInAuth(cfg);
      const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

      const check = result.checks.find((c) => c.label === 'Attachment field')!;
      expect(check.pass).toBe(false);
      expect(check.message).toMatch(/could not/i);
      expect(check.message).toContain('Local/attachments/attachment');
    });
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
