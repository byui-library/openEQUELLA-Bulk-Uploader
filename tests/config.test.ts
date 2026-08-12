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
    });
    expect(cfg.baseUrl).toBe('https://example.test');
  });

  it('defaults authMode to "code" and redirectUri to the base url WITH a trailing slash (Bug 2)', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test/',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
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
      OEQ_REDIRECT_URI: 'https://different.test/',
    });
    expect(cfg.redirectUri).toBe('https://different.test/');
  });

  it('honours an explicit OEQ_REDIRECT_URI verbatim when it has NO trailing slash too -- never adds one', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_REDIRECT_URI: 'https://different.test',
    });
    expect(cfg.redirectUri).toBe('https://different.test');
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
    });
    const provider = createAuthProvider(cfg, {}, new FileTokenStore(join(dir, 'token.json')));
    expect(provider).toBeInstanceOf(AuthorizationCodeAuth);
  });

  it('returns an OAuthClientCredentials for "client_credentials" mode', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_AUTH_MODE: 'client_credentials',
    });
    const provider = createAuthProvider(cfg, {});
    expect(provider).toBeInstanceOf(OAuthClientCredentials);
  });
});

describe('password auth mode', () => {
  const base = {
    OEQ_BASE_URL: 'https://oeq.example.edu',
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
