import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, createAuthProvider } from '../src/core/config.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { AuthorizationCodeAuth } from '../src/core/authCode.js';
import { FileTokenStore } from '../src/core/tokenStore.js';

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

  it('defaults authMode to "code" and redirectUri to the (slash-stripped) base url', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test/',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
    });
    expect(cfg.authMode).toBe('code');
    expect(cfg.redirectUri).toBe('https://example.test');
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

  it('honours an explicit OEQ_REDIRECT_URI and strips its trailing slash', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_REDIRECT_URI: 'https://different.test/',
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
