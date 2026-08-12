import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runPreflight, summarise } from '../src/core/preflight.js';
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

/**
 * A config pointed somewhere other than the mock, for the checks that read
 * the configured address itself rather than calling it. Deliberately paired
 * with an empty token store below so nothing is ever fetched: `getToken()`
 * fails locally, the pre-flight stops after the sign-in checks, and the test
 * makes no network request at all.
 */
function offlineCfg(env: Record<string, string | undefined>): Config {
  return loadConfig({
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: 'secret',
    OEQ_COLLECTION_UUID: 'c1',
    ...env,
  });
}

/** A pre-flight that cannot reach anything: no token, so it stops early. */
async function offlinePreflight(cfg: Config) {
  const auth = new AuthorizationCodeAuth(
    cfg.baseUrl,
    cfg.clientId,
    cfg.clientSecret,
    cfg.redirectUri,
    new FileTokenStore(join(dir, 'token.json')),
  );
  return runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));
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
    mock.state.collections.push({
      uuid: 'c1',
      name: 'Faculty Content',
      privileges: ['CREATE_ITEM'],
      schemaUuid: 's1',
    });
    mock.state.schemas.push({ uuid: 's1', namePath: '/MWDL/title', paths: ['MWDL/title'] });
    const auth = await loggedInAuth(cfg);
    const client = new OeqClient(cfg.baseUrl, auth);

    const result = await runPreflight(cfg, auth, client);

    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.label)).toEqual([
      'HTTPS',
      'Token',
      'Sign-in method',
      'Identity',
      'Collection',
      'Collections available',
      'Permission',
      'Attachment field',
      'Duplicate detection',
    ]);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  /**
   * Amended when HTTPS and Sign-in method were added. The premise is
   * unchanged and is asserted more strictly than before: nothing that needs
   * the network runs once the token check has failed, because every one of
   * those failures would just be a confusing echo of the same root cause.
   *
   * HTTPS reads the configured address and calls nothing. Sign-in method
   * reports which method just failed, which is the whole reason it exists --
   * openEQUELLA's own answer here is "No OAuth client can be found with the
   * supplied client_id (null)", and a site needs to be told which mode
   * produced that before the report stops.
   */
  it('runs no network check, and does not run the collection checks, when there is no token', async () => {
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
    expect(result.checks.map((c) => c.label)).toEqual(['HTTPS', 'Token', 'Sign-in method']);
    for (const label of [
      'Identity',
      'Collection',
      'Collections available',
      'Permission',
      'Attachment field',
      'Duplicate detection',
    ]) {
      expect(result.checks.find((c) => c.label === label)).toBeUndefined();
    }
    const token = result.checks.find((c) => c.label === 'Token')!;
    expect(token.pass).toBe(false);
    expect(token.message).toMatch(/oeq-upload login/);
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

    // Found by label, not by index: this test is about the Token message, and
    // HTTPS now precedes it.
    const token = result.checks.find((c) => c.label === 'Token')!;
    expect(token.message).toContain('Call the oeq_login_url tool');
    // The default CLI instruction must be gone entirely, not just appended to.
    expect(token.message).not.toMatch(/oeq-upload login/);
    // ...from anywhere in the report, not merely from the line it was
    // substituted in: an MCP caller has no shell to run it in.
    expect(result.checks.map((c) => c.message).join('\n')).not.toMatch(/oeq-upload login/);
    // The "why" (no cached token, which host) is still present -- only the
    // actionable tail was swapped.
    expect(token.message).toContain('No cached OAuth token');
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

  /**
   * Only BYU-Idaho's instances were available while this tool was made
   * institution-agnostic. The first site to run it elsewhere is the real
   * test, and these four lines are how they tell us what broke without us
   * having access to their instance -- so each says what a failure means for
   * a real run, not merely what was observed.
   */
  describe('the compatibility checks a new institution needs', () => {
    const contributable = { uuid: 'c1', name: 'Faculty Content', privileges: ['CREATE_ITEM'] };

    describe('HTTPS', () => {
      it('passes for an https address, and says why the address matters', async () => {
        const result = await offlinePreflight(offlineCfg({ OEQ_BASE_URL: 'https://oeq.example.edu' }));

        const check = result.checks.find((c) => c.label === 'HTTPS')!;
        expect(check.pass).toBe(true);
        expect(check.message).toContain('https://oeq.example.edu');
        expect(check.message).toMatch(/password/i);
      });

      /**
       * openEQUELLA takes the password as a query parameter, so over http it
       * travels in clear text in the request line. A site must learn that
       * from this report rather than from a packet capture.
       */
      it('fails for a plain-http address, naming the variable and the exposure', async () => {
        const result = await offlinePreflight(offlineCfg({ OEQ_BASE_URL: 'http://oeq.example.edu' }));

        const check = result.checks.find((c) => c.label === 'HTTPS')!;
        expect(check.pass).toBe(false);
        expect(check.message).toContain('OEQ_BASE_URL');
        expect(check.message).toMatch(/password/i);
        expect(result.ok).toBe(false);
      });

      it('fails for an address that is not a web address at all', async () => {
        const result = await offlinePreflight(offlineCfg({ OEQ_BASE_URL: 'oeq.example.edu' }));

        const check = result.checks.find((c) => c.label === 'HTTPS')!;
        expect(check.pass).toBe(false);
        expect(check.message).toContain('oeq.example.edu');
      });

      /**
       * A loopback address never leaves the machine, so the clear-text
       * exposure the https requirement exists to prevent cannot happen. The
       * message must still say that, so nobody reads the pass as licence to
       * use http against a real host.
       */
      it('accepts a loopback address and says why the exemption is narrow', async () => {
        const cfg = cfgFor(mock, 'c1');
        mock.state.collections.push(contributable);
        const auth = await loggedInAuth(cfg);
        const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

        const check = result.checks.find((c) => c.label === 'HTTPS')!;
        expect(check.pass).toBe(true);
        expect(check.message).toMatch(/loopback/i);
        expect(check.message).toMatch(/https/i);
      });
    });

    describe('Sign-in method', () => {
      it('names the method that was actually used when sign-in worked', async () => {
        const cfg = cfgFor(mock, 'c1');
        mock.state.collections.push(contributable);
        const auth = await loggedInAuth(cfg);
        const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

        const check = result.checks.find((c) => c.label === 'Sign-in method')!;
        expect(check.pass).toBe(true);
        expect(check.message).toContain('OEQ_AUTH_MODE');
        expect(check.message).toMatch(/code/);
      });

      it('names the method that failed, rather than leaving it to be inferred', async () => {
        const result = await offlinePreflight(offlineCfg({ OEQ_BASE_URL: 'https://oeq.example.edu' }));

        const check = result.checks.find((c) => c.label === 'Sign-in method')!;
        expect(check.pass).toBe(false);
        expect(check.message).toContain('OEQ_AUTH_MODE');
      });

      /**
       * THE CASE THIS CHECK EXISTS FOR. A site fills in OEQ_USERNAME and
       * OEQ_PASSWORD, never sets OEQ_AUTH_MODE, and so silently gets the
       * default OAuth mode -- which openEQUELLA reports as "No OAuth client
       * can be found with the supplied client_id (null)", naming neither
       * variable they set nor the one they didn't.
       */
      it('says the username and password are not being used when the mode is OAuth', async () => {
        const result = await offlinePreflight(
          offlineCfg({
            OEQ_BASE_URL: 'https://oeq.example.edu',
            OEQ_USERNAME: 'jsmith',
            OEQ_PASSWORD: 'hunter2',
          }),
        );

        const check = result.checks.find((c) => c.label === 'Sign-in method')!;
        expect(check.pass).toBe(false);
        expect(check.message).toContain('OEQ_USERNAME');
        expect(check.message).toContain('OEQ_AUTH_MODE=password');
        // The confusing server-side symptom, so a search for it lands here.
        expect(check.message).toMatch(/client_id/);
        // ...and never the password itself.
        expect(check.message).not.toContain('hunter2');
      });
    });

    describe('Collections available', () => {
      it('reports how many collections this account can create in', async () => {
        const cfg = cfgFor(mock, 'c1');
        mock.state.collections.push(contributable, {
          uuid: 'c2',
          name: 'Other',
          privileges: ['CREATE_ITEM'],
        });
        const auth = await loggedInAuth(cfg);
        const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

        const check = result.checks.find((c) => c.label === 'Collections available')!;
        expect(check.pass).toBe(true);
        expect(check.message).toMatch(/\b2\b/);
      });

      /**
       * Zero is a real, diagnosable state, not an error: the account
       * authenticated fine and can create nothing. That is what a viewer-only
       * account looks like, and saying so is what stops a site debugging the
       * wrong layer.
       */
      it('fails, and explains what zero means, when the account can create nothing', async () => {
        const cfg = cfgFor(mock, 'c1');
        mock.state.collections.push({ uuid: 'c1', name: 'View Only', privileges: [] });
        const auth = await loggedInAuth(cfg);
        const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

        const check = result.checks.find((c) => c.label === 'Collections available')!;
        expect(check.pass).toBe(false);
        expect(check.message).toMatch(/CREATE_ITEM/);
        expect(check.message).toMatch(/permission|viewer|contribute/i);
      });

      /**
       * "The list could not be read" must never render as "you can create in
       * nothing" -- one is a permissions problem to take to an administrator,
       * the other is a connectivity problem, and they have no fix in common.
       */
      it('distinguishes a list that could not be read from a list that is empty', async () => {
        const cfg = cfgFor(mock, 'c1');
        mock.state.collections.push(contributable);
        const auth = await loggedInAuth(cfg);
        const client = new OeqClient(cfg.baseUrl, auth);
        // The token is already cached, so closing the mock leaves sign-in
        // intact and makes every subsequent call a genuine connection
        // failure -- no stubbing, and it proves no check throws.
        await mock.close();

        const result = await runPreflight(cfg, auth, client);

        const check = result.checks.find((c) => c.label === 'Collections available')!;
        expect(check.pass).toBe(false);
        expect(check.message).toMatch(/could not/i);
        expect(check.message).not.toMatch(/\bno collection|zero\b/i);
        // Every later check still ran and reported, rather than one throw
        // hiding the rest.
        expect(result.checks.map((c) => c.label)).toContain('Duplicate detection');
      });
    });

    /**
     * The highest-value line in the report. Without a declared name path
     * `findDuplicates` reports could-not-check for EVERY row (see
     * duplicates.ts), and a site should learn that before running a batch
     * rather than partway through one.
     */
    describe('Duplicate detection', () => {
      it('passes, naming the path it will match on, when the schema declares one', async () => {
        const cfg = cfgFor(mock, 'c1');
        mock.state.collections.push({ ...contributable, schemaUuid: 's1' });
        mock.state.schemas.push({
          uuid: 's1',
          namePath: '/Local/item/name',
          paths: ['Local/item/name'],
        });
        const auth = await loggedInAuth(cfg);
        const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

        const check = result.checks.find((c) => c.label === 'Duplicate detection')!;
        expect(check.pass).toBe(true);
        expect(check.message).toContain('Local/item/name');
        // The BYU-Idaho path must not appear anywhere: it was hardcoded once,
        // and a report that quietly reverts to it is worse than none.
        expect(check.message).not.toContain('MWDL');
      });

      it('fails, naming the consequence, when the schema declares no name path', async () => {
        const cfg = cfgFor(mock, 'c1');
        mock.state.collections.push({ ...contributable, schemaUuid: 's1' });
        mock.state.schemas.push({ uuid: 's1', namePath: '', paths: ['Local/item/name'] });
        const auth = await loggedInAuth(cfg);
        const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

        const check = result.checks.find((c) => c.label === 'Duplicate detection')!;
        expect(check.pass).toBe(false);
        expect(check.message).toMatch(/could not check/i);
        expect(check.message).toMatch(/every row/i);
        expect(result.ok).toBe(false);
      });

      /**
       * Unverifiable must read as unverified, never as either verdict --
       * "could not check" is not reported as clean anywhere else in this tool.
       */
      it('reads as unverified, not as a verdict, when the collection names no schema', async () => {
        const cfg = cfgFor(mock, 'c1');
        mock.state.collections.push(contributable); // no schemaUuid
        const auth = await loggedInAuth(cfg);
        const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

        const check = result.checks.find((c) => c.label === 'Duplicate detection')!;
        expect(check.pass).toBe(false);
        expect(check.message).toMatch(/could not be (confirmed|read|checked)/i);
        expect(check.message).toMatch(/schema/i);
      });

      it('reads as unverified when the schema itself cannot be read', async () => {
        const cfg = cfgFor(mock, 'c1');
        // Declares a schema the mock has no record of -- a 404 on read.
        mock.state.collections.push({ ...contributable, schemaUuid: 'missing-schema' });
        const auth = await loggedInAuth(cfg);
        const result = await runPreflight(cfg, auth, new OeqClient(cfg.baseUrl, auth));

        const check = result.checks.find((c) => c.label === 'Duplicate detection')!;
        expect(check.pass).toBe(false);
        expect(check.message).toContain('missing-schema');
        expect(check.message).toMatch(/could not/i);
      });

      /**
       * Two checks read the same schema. Reading it twice would double the
       * requests for one answer, and could report two different truths if it
       * changed between them.
       */
      it('reads the collection schema once, sharing it with the attachment-field check', async () => {
        const cfg = cfgFor(mock, 'c1', 'Local/attachments/attachment');
        mock.state.collections.push({ ...contributable, schemaUuid: 's1' });
        mock.state.schemas.push({
          uuid: 's1',
          namePath: '/Local/item/name',
          paths: ['Local/item/name', 'Local/attachments/attachment'],
        });
        const auth = await loggedInAuth(cfg);
        const client = new OeqClient(cfg.baseUrl, auth);
        let schemaReads = 0;
        const real = client.getSchema.bind(client);
        client.getSchema = async (uuid: string) => {
          schemaReads++;
          return real(uuid);
        };

        const result = await runPreflight(cfg, auth, client);

        expect(schemaReads).toBe(1);
        expect(result.checks.find((c) => c.label === 'Attachment field')!.pass).toBe(true);
        expect(result.checks.find((c) => c.label === 'Duplicate detection')!.pass).toBe(true);
      });
    });
  });

  /**
   * The verdict line is shared by both front ends. It used to be a literal
   * string duplicated in cli/index.ts and mcp/index.ts, which is how two
   * surfaces meant to say the same thing start saying different things.
   */
  describe('summarise', () => {
    it('names the failing checks rather than sending the reader back up a nine-line report', () => {
      const line = summarise({
        ok: false,
        checks: [
          { label: 'HTTPS', pass: true, message: '' },
          { label: 'Collections available', pass: false, message: '' },
          { label: 'Duplicate detection', pass: false, message: '' },
        ],
      });

      expect(line).toContain('2 of 3 checks failed');
      expect(line).toContain('Collections available');
      expect(line).toContain('Duplicate detection');
      expect(line).not.toContain('HTTPS');
    });

    it('says so plainly when nothing failed', () => {
      expect(summarise({ ok: true, checks: [{ label: 'HTTPS', pass: true, message: '' }] })).toBe(
        'All checks passed.',
      );
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
