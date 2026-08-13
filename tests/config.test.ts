import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, createAuthProvider } from '../src/core/config.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { AuthorizationCodeAuth } from '../src/core/authCode.js';
import { FileTokenStore } from '../src/core/tokenStore.js';
import { UsernamePasswordAuth } from '../src/core/passwordAuth.js';

describe('loadConfig', () => {
  it('reads values from the environment', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
      OEQ_SCHEMA_UUID: 's1',
    });
    expect(cfg.baseUrl).toBe('https://example.test');
    expect(cfg.collectionUuid).toBe('c1');
  });

  it('names every missing variable at once, not one at a time', () => {
    expect(() => loadConfig({})).toThrow(/OEQ_BASE_URL.*OEQ_CLIENT_ID.*OEQ_CLIENT_SECRET/s);
  });

  it('strips a trailing slash from the base url', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test/',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
    });
    expect(cfg.baseUrl).toBe('https://example.test');
  });

  it('defaults authMode to "code" and redirectUri to the base url WITH a trailing slash (Bug 2)', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test/',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
    });
    expect(cfg.authMode).toBe('code');
    // baseUrl itself is still slash-stripped, but the default redirectUri
    // adds the slash back -- the registered client on this instance requires
    // it (verified live; see authCode.ts's header comment).
    expect(cfg.baseUrl).toBe('https://example.test');
    expect(cfg.redirectUri).toBe('https://example.test/');
  });

  it('accepts an explicit OEQ_AUTH_MODE of client_credentials', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
      OEQ_AUTH_MODE: 'client_credentials',
    });
    expect(cfg.authMode).toBe('client_credentials');
  });

  it('rejects an unrecognised OEQ_AUTH_MODE', () => {
    expect(() =>
      loadConfig({
        OEQ_BASE_URL: 'https://example.test',
        OEQ_CLIENT_ID: 'id',
        OEQ_CLIENT_SECRET: 'secret',
        OEQ_AUTH_MODE: 'bogus',
      }),
    ).toThrow(/OEQ_AUTH_MODE/);
  });

  it('honours an explicit OEQ_REDIRECT_URI verbatim, including its trailing slash (Bug 2 -- no longer stripped)', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
      OEQ_REDIRECT_URI: 'https://different.test/',
    });
    expect(cfg.redirectUri).toBe('https://different.test/');
  });

  it('honours an explicit OEQ_REDIRECT_URI verbatim when it has NO trailing slash too -- never adds one', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
      OEQ_REDIRECT_URI: 'https://different.test',
    });
    expect(cfg.redirectUri).toBe('https://different.test');
  });
});

/**
 * There is no default collection, in any mode.
 *
 * `OEQ_COLLECTION_UUID` used to fall back to BYU-Idaho's own collection uuid,
 * so an institution that never set it got a valid-looking identifier they had
 * never chosen; the failure then arrived from the server as a not-found on a
 * uuid that means nothing to them. Naming the missing variable is a far better
 * outcome than any default, and every mode needs a collection -- the required
 * list is mode-dependent, so this has to hold in all three.
 */
describe('the target collection is never guessed', () => {
  it('names OEQ_COLLECTION_UUID when it is missing in the default "code" mode', () => {
    expect(() =>
      loadConfig({
        OEQ_BASE_URL: 'https://oeq.example.edu',
        OEQ_CLIENT_ID: 'id',
        OEQ_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/OEQ_COLLECTION_UUID/);
  });

  it('names OEQ_COLLECTION_UUID when it is missing in client_credentials mode', () => {
    expect(() =>
      loadConfig({
        OEQ_BASE_URL: 'https://oeq.example.edu',
        OEQ_CLIENT_ID: 'id',
        OEQ_CLIENT_SECRET: 'secret',
        OEQ_AUTH_MODE: 'client_credentials',
      }),
    ).toThrow(/OEQ_COLLECTION_UUID/);
  });

  it('names OEQ_COLLECTION_UUID when it is missing in password mode', () => {
    expect(() =>
      loadConfig({
        OEQ_BASE_URL: 'https://oeq.example.edu',
        OEQ_AUTH_MODE: 'password',
        OEQ_USERNAME: 'jsmith',
        OEQ_PASSWORD: 'hunter2',
      }),
    ).toThrow(/OEQ_COLLECTION_UUID/);
  });

  /**
   * The manifest records it and nothing ever sends it (see CLAUDE.md), so
   * demanding it would be a barrier to entry for a value that does nothing.
   * Empty, though -- never another institution's schema uuid.
   */
  it('leaves OEQ_SCHEMA_UUID optional and empty rather than defaulting to a real schema', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://oeq.example.edu',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
    });
    expect(cfg.schemaUuid).toBe('');
  });
});

/**
 * The attachment-uuid convenience field. See runner.ts: when this is unset,
 * nothing is written, because the path names a node BYU-Idaho's schema
 * declares and nobody else's does.
 */
describe('attachmentUuidPath', () => {
  const base = {
    OEQ_BASE_URL: 'https://oeq.example.edu',
    OEQ_CLIENT_ID: 'id',
    OEQ_CLIENT_SECRET: 'secret',
    OEQ_COLLECTION_UUID: 'c1',
  };

  it('is empty when OEQ_ATTACHMENT_UUID_PATH is not set', () => {
    expect(loadConfig(base).attachmentUuidPath).toBe('');
  });

  it('reads OEQ_ATTACHMENT_UUID_PATH when it is set', () => {
    const cfg = loadConfig({ ...base, OEQ_ATTACHMENT_UUID_PATH: 'Local/attachments/attachment' });
    expect(cfg.attachmentUuidPath).toBe('Local/attachments/attachment');
  });

  /**
   * A path pasted out of a schema browser arrives with a leading slash
   * (`/MWDL/title` is how openEQUELLA itself spells them) or with stray
   * whitespace from a .env line. Spreadsheet headers and the metadata builder
   * both use the slashless form, so a mismatch here would write to a path
   * nothing else agrees with -- silently, since the field is write-only.
   */
  it('trims whitespace and a leading slash so it matches spreadsheet-header form', () => {
    const cfg = loadConfig({ ...base, OEQ_ATTACHMENT_UUID_PATH: '  /Local/attachments/attachment ' });
    expect(cfg.attachmentUuidPath).toBe('Local/attachments/attachment');
  });
});

describe('createAuthProvider', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oeq-config-token-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an AuthorizationCodeAuth for the default "code" mode', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
    });
    const provider = createAuthProvider(cfg, {}, new FileTokenStore(join(dir, 'token.json')));
    expect(provider).toBeInstanceOf(AuthorizationCodeAuth);
  });

  it('returns an OAuthClientCredentials for "client_credentials" mode', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
      OEQ_AUTH_MODE: 'client_credentials',
    });
    const provider = createAuthProvider(cfg, {});
    expect(provider).toBeInstanceOf(OAuthClientCredentials);
  });
});

describe('password auth mode', () => {
  const base = {
    OEQ_BASE_URL: 'https://oeq.example.edu',
    OEQ_COLLECTION_UUID: 'c1',
    OEQ_AUTH_MODE: 'password',
    OEQ_USERNAME: 'jsmith',
    OEQ_PASSWORD: 'hunter2',
  };

  it('loads without any OAuth client credentials', () => {
    const cfg = loadConfig(base);
    expect(cfg.authMode).toBe('password');
    expect(cfg.username).toBe('jsmith');
  });

  it('builds a UsernamePasswordAuth provider', () => {
    expect(createAuthProvider(loadConfig(base))).toBeInstanceOf(UsernamePasswordAuth);
  });

  it('names the missing variable when the password is absent', () => {
    expect(() => loadConfig({ ...base, OEQ_PASSWORD: undefined })).toThrow(/OEQ_PASSWORD/);
  });

  it('still demands client credentials in the OAuth modes', () => {
    expect(() =>
      loadConfig({ OEQ_BASE_URL: 'https://oeq.example.edu', OEQ_AUTH_MODE: 'code' }),
    ).toThrow(/OEQ_CLIENT_ID/);
  });

  it('rejects an unknown mode by listing the three that exist', () => {
    expect(() => loadConfig({ ...base, OEQ_AUTH_MODE: 'saml' })).toThrow(/password/);
  });
});
