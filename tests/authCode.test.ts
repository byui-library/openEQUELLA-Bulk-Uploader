import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthorizationCodeAuth } from '../src/core/authCode.js';
import { FileTokenStore } from '../src/core/tokenStore.js';
import { ApiError, OeqError } from '../src/core/errors.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

let mock: MockServer;
let dir: string;

beforeEach(async () => {
  mock = await startMockServer();
  dir = await mkdtemp(join(tmpdir(), 'oeq-token-'));
});
afterEach(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

const tokenPath = () => join(dir, 'token.json');

describe('AuthorizationCodeAuth — getAuthorizeUrl', () => {
  it('produces the expected URL with the British spelling and a normalised redirect_uri', () => {
    const auth = new AuthorizationCodeAuth(
      'https://example.test',
      'client-1',
      'secret',
      'https://example.test/',
      new FileTokenStore(tokenPath()),
    );
    const url = new URL(auth.getAuthorizeUrl());
    expect(url.origin + url.pathname).toBe('https://example.test/oauth/authorise');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    // Trailing slash stripped: the server normalises it off anyway, and
    // exchangeCode() must send back exactly what it echoed.
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test');
  });

  it('strips a trailing slash from the configured redirect URI', () => {
    const withSlash = new AuthorizationCodeAuth(
      'https://example.test',
      'client-1',
      'secret',
      'https://example.test/',
      new FileTokenStore(tokenPath()),
    );
    const withoutSlash = new AuthorizationCodeAuth(
      'https://example.test',
      'client-1',
      'secret',
      'https://example.test',
      new FileTokenStore(tokenPath()),
    );
    const a = new URL(withSlash.getAuthorizeUrl()).searchParams.get('redirect_uri');
    const b = new URL(withoutSlash.getAuthorizeUrl()).searchParams.get('redirect_uri');
    expect(a).toBe('https://example.test');
    expect(a).toBe(b);
  });
});

describe('AuthorizationCodeAuth — exchangeCode', () => {
  it('succeeds and caches the token', async () => {
    mock.state.validAuthCodes.add('good-code');
    const auth = new AuthorizationCodeAuth(
      mock.url,
      'good-id',
      'secret',
      mock.url,
      new FileTokenStore(tokenPath()),
    );
    await auth.exchangeCode('good-code');
    expect(await auth.getToken()).toBe(mock.state.issuedTokens[0]);
    // getToken() again must not mint a second token -- it's cached.
    await auth.getToken();
    expect(mock.state.issuedTokens).toHaveLength(1);
  });

  it('tolerates a trailing slash on the configured redirect URI (normalised to match the mock)', async () => {
    mock.state.validAuthCodes.add('good-code');
    const auth = new AuthorizationCodeAuth(
      mock.url,
      'good-id',
      'secret',
      `${mock.url}/`, // trailing slash -- must still match state.expectedRedirectUri === mock.url
      new FileTokenStore(tokenPath()),
    );
    await expect(auth.exchangeCode('good-code')).resolves.toBeUndefined();
  });

  it('persists the token to the store so a detached process can pick it up', async () => {
    mock.state.validAuthCodes.add('good-code');
    const path = tokenPath();
    const auth = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, new FileTokenStore(path));
    await auth.exchangeCode('good-code');

    // A fresh instance, as a detached child process would construct, with
    // no exchangeCode() call of its own -- only the shared store.
    const detached = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, new FileTokenStore(path));
    expect(await detached.getToken()).toBe(mock.state.issuedTokens[0]);
  });

  it('raises a clear error on a redirect_uri mismatch', async () => {
    mock.state.validAuthCodes.add('good-code');
    const auth = new AuthorizationCodeAuth(
      mock.url,
      'good-id',
      'secret',
      'https://wrong.example', // does not match state.expectedRedirectUri
      new FileTokenStore(tokenPath()),
    );
    await expect(auth.exchangeCode('good-code')).rejects.toThrow(/redirect_uri/i);
  });

  it('raises a clear error on an invalid or expired code', async () => {
    const auth = new AuthorizationCodeAuth(
      mock.url,
      'good-id',
      'secret',
      mock.url,
      new FileTokenStore(tokenPath()),
    );
    // Never added to mock.state.validAuthCodes.
    await expect(auth.exchangeCode('stale-code')).rejects.toThrow(/invalid|expired/i);
  });
});

describe('AuthorizationCodeAuth — getToken without a prior exchange', () => {
  it('throws an actionable error naming the actual login command and makes no network call', async () => {
    const auth = new AuthorizationCodeAuth(
      mock.url,
      'good-id',
      'secret',
      mock.url,
      new FileTokenStore(tokenPath()),
    );
    await expect(auth.getToken()).rejects.toThrow(OeqError);
    await expect(auth.getToken()).rejects.toThrow(/oeq-upload login/);
    // Internal API names are not operator-actionable -- must not appear.
    await expect(auth.getToken()).rejects.not.toThrow(/getAuthorizeUrl|exchangeCode/);
    // No token was ever issued by the mock -- proves getToken() didn't fetch.
    expect(mock.state.issuedTokens).toHaveLength(0);
  });

  it('produces exactly the operator-facing message when there is no cached token', async () => {
    const auth = new AuthorizationCodeAuth(
      mock.url,
      'good-id',
      'secret',
      mock.url,
      new FileTokenStore(tokenPath()),
    );
    await expect(auth.getToken()).rejects.toThrow(
      `No cached OAuth token for ${mock.url}.\nRun:  oeq-upload login`,
    );
  });

  it('reports a baseUrl mismatch distinctly, without using the stored token', async () => {
    const path = tokenPath();
    const store = new FileTokenStore(path);
    await store.save({ accessToken: 'tok-from-other-instance', baseUrl: 'https://other.test' });
    const auth = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, store);
    await expect(auth.getToken()).rejects.toThrow(/other\.test/);
    await expect(auth.getToken()).rejects.toThrow(/oeq-upload login/);
  });

  it('reports an expired token distinctly, without using it', async () => {
    const path = tokenPath();
    const store = new FileTokenStore(path);
    await store.save({
      accessToken: 'tok-expired',
      baseUrl: mock.url,
      expiresAt: Date.now() - 1000,
    });
    const auth = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, store);
    await expect(auth.getToken()).rejects.toThrow(/expired/i);
  });
});

describe('AuthorizationCodeAuth — authHeader', () => {
  it('formats the header as openEQUELLA expects', async () => {
    mock.state.validAuthCodes.add('good-code');
    const auth = new AuthorizationCodeAuth(
      mock.url,
      'good-id',
      'secret',
      mock.url,
      new FileTokenStore(tokenPath()),
    );
    await auth.exchangeCode('good-code');
    const header = await auth.authHeader();
    expect(header['X-Authorization']).toBe(`access_token=${mock.state.issuedTokens[0]}`);
  });
});

describe('AuthorizationCodeAuth — invalidate', () => {
  it('clears both the in-memory token and the persisted store, so the next getToken() fails fast', async () => {
    mock.state.validAuthCodes.add('good-code');
    const path = tokenPath();
    const store = new FileTokenStore(path);
    const auth = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, store);
    await auth.exchangeCode('good-code');

    auth.invalidate();

    // The store itself is empty -- not just this instance's in-memory copy.
    expect(await store.loadRaw()).toBeNull();
    // getToken() throws the login-required error immediately rather than
    // returning the (now-cleared) stale token.
    await expect(auth.getToken()).rejects.toThrow(OeqError);
    await expect(auth.getToken()).rejects.toThrow(/oeq-upload login/);
    // And crucially: no network call was made trying to refresh it.
    expect(mock.state.issuedTokens).toHaveLength(1);
  });

  it('a fresh instance reading the same store also sees no token after invalidate()', async () => {
    // Simulates the real hazard: client.ts calls invalidate() on a 401, then
    // upload.ts (a different call site, effectively "a fresh look") must
    // also see the token gone -- not just the instance that happened to call
    // invalidate().
    mock.state.validAuthCodes.add('good-code');
    const path = tokenPath();
    const auth = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, new FileTokenStore(path));
    await auth.exchangeCode('good-code');
    auth.invalidate();

    const other = new AuthorizationCodeAuth(mock.url, 'good-id', 'secret', mock.url, new FileTokenStore(path));
    await expect(other.getToken()).rejects.toThrow(OeqError);
  });
});

describe('FileTokenStore', () => {
  it('round-trips a saved token', async () => {
    const store = new FileTokenStore(tokenPath());
    await store.save({ accessToken: 'tok-1', baseUrl: 'https://a.test' });
    expect(await store.load('https://a.test')).toBe('tok-1');
  });

  it('rejects a token issued for a different baseUrl', async () => {
    const store = new FileTokenStore(tokenPath());
    await store.save({ accessToken: 'tok-1', baseUrl: 'https://a.test' });
    expect(await store.load('https://b.test')).toBeNull();
  });

  it('treats an expired token as absent', async () => {
    const store = new FileTokenStore(tokenPath());
    await store.save({ accessToken: 'tok-1', baseUrl: 'https://a.test', expiresAt: Date.now() - 1000 });
    expect(await store.load('https://a.test')).toBeNull();
  });

  it('treats a not-yet-expired token as present', async () => {
    const store = new FileTokenStore(tokenPath());
    await store.save({ accessToken: 'tok-1', baseUrl: 'https://a.test', expiresAt: Date.now() + 60_000 });
    expect(await store.load('https://a.test')).toBe('tok-1');
  });

  it('treats a missing file as no token, not an error', async () => {
    const store = new FileTokenStore(join(dir, 'does-not-exist.json'));
    expect(await store.load('https://a.test')).toBeNull();
    expect(await store.loadRaw()).toBeNull();
  });

  it('clear() removes a saved token', async () => {
    const path = tokenPath();
    const store = new FileTokenStore(path);
    await store.save({ accessToken: 'tok-1', baseUrl: 'https://a.test' });
    await store.clear();
    expect(await store.load('https://a.test')).toBeNull();
  });

  it('clear() on a store that never saved anything does not throw', async () => {
    const store = new FileTokenStore(join(dir, 'never-existed.json'));
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

/** A throwaway server used to probe error handling paths the shared mock doesn't model. */
function startProbeServer(
  handler: (info: { body: string; url: string }) => { status: number; body: string },
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const { status, body } = handler({
          body: Buffer.concat(chunks).toString('utf8'),
          url: req.url ?? '',
        });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('AuthorizationCodeAuth — secret handling and malformed responses', () => {
  it('never leaks the client secret, raw or percent-encoded, into a thrown error', async () => {
    // Same base64-alphabet secret as tests/auth.test.ts: '+', '/', '=', '&'
    // are exactly the characters that differ between the raw secret and its
    // query-string (percent-encoded) form.
    const secret = 'a+b/c=d&e';
    const probe = await startProbeServer(({ url }) => ({
      status: 400,
      body: JSON.stringify({
        error: 'invalid_grant',
        // Simulate a server that (unhelpfully) echoes the request URL back
        // exactly as it appeared on the wire, i.e. percent-encoded.
        debug: `rejected request: ${url}`,
      }),
    }));
    try {
      const auth = new AuthorizationCodeAuth(
        probe.url,
        'good-id',
        secret,
        probe.url,
        new FileTokenStore(tokenPath()),
      );
      let caught: unknown;
      try {
        await auth.exchangeCode('some-code');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      const err = caught as ApiError;
      const encoded = encodeURIComponent(secret);
      expect(err.message).not.toContain(secret);
      expect(err.message).not.toContain(encoded);
      expect(err.body).not.toContain(secret);
      expect(err.body).not.toContain(encoded);
      expect(String(err.stack)).not.toContain(secret);
      expect(String(err.stack)).not.toContain(encoded);
    } finally {
      await probe.close();
    }
  });

  it('produces a clear error (not a raw SyntaxError) when the token response is not JSON', async () => {
    const probe = await startProbeServer(() => ({ status: 200, body: 'not json at all' }));
    try {
      const auth = new AuthorizationCodeAuth(
        probe.url,
        'good-id',
        'secret',
        probe.url,
        new FileTokenStore(tokenPath()),
      );
      let caught: unknown;
      try {
        await auth.exchangeCode('some-code');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).not.toBeInstanceOf(SyntaxError);
      expect((caught as ApiError).message).toMatch(/json/i);
    } finally {
      await probe.close();
    }
  });
});
