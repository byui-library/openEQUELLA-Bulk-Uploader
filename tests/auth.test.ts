import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { ApiError } from '../src/core/errors.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

let mock: MockServer;
beforeEach(async () => {
  mock = await startMockServer();
});
afterEach(async () => {
  await mock.close();
});

describe('OAuthClientCredentials', () => {
  it('exchanges client credentials for a token', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    expect(await auth.getToken()).toBe(mock.state.issuedTokens[0]);
  });

  it('caches the token across calls', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    await auth.getToken();
    await auth.getToken();
    expect(mock.state.issuedTokens).toHaveLength(1);
  });

  it('mints a new token after invalidate()', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    await auth.getToken();
    auth.invalidate();
    await auth.getToken();
    expect(mock.state.issuedTokens).toHaveLength(2);
  });

  it('raises a clear error on bad credentials', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'bad-id', 'secret');
    await expect(auth.getToken()).rejects.toThrow(/credential/i);
  });

  it('formats the header as openEQUELLA expects', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    const header = await auth.authHeader();
    expect(header['X-Authorization']).toMatch(/^access_token=token-/);
  });
});

describe('OAuthClientCredentials — additional hardening', () => {
  it('collapses concurrent getToken() calls into a single token request', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    const tokens = await Promise.all([
      auth.getToken(),
      auth.getToken(),
      auth.getToken(),
      auth.getToken(),
      auth.getToken(),
    ]);
    expect(mock.state.issuedTokens).toHaveLength(1);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe(mock.state.issuedTokens[0]);
  });

  it('authHeader() triggers a fetch when no token is cached', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    expect(mock.state.issuedTokens).toHaveLength(0);
    const header = await auth.authHeader();
    expect(mock.state.issuedTokens).toHaveLength(1);
    expect(header['X-Authorization']).toBe(`access_token=${mock.state.issuedTokens[0]}`);
  });

  it('discards (does not cache) a token whose fetch was invalidated mid-flight', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    const first = auth.getToken(); // starts fetch #1, not yet resolved
    auth.invalidate(); // fires while fetch #1 is in flight
    const firstToken = await first;
    expect(firstToken).toBe(mock.state.issuedTokens[0]); // caller still gets a valid token

    // Because invalidate() landed mid-flight, that token must NOT have been
    // cached — the next getToken() should mint a fresh one rather than
    // silently reusing (or worse, being stuck unable to refresh).
    const second = await auth.getToken();
    expect(mock.state.issuedTokens).toHaveLength(2);
    expect(second).toBe(mock.state.issuedTokens[1]);
    expect(second).not.toBe(firstToken);

    // And now that it's cached, a third call should NOT trigger another fetch.
    await auth.getToken();
    expect(mock.state.issuedTokens).toHaveLength(2);
  });

  it('does not hand an invalidated in-flight token to a caller who calls getToken() after invalidate()', async () => {
    // Chosen semantics (option (a) from review): invalidate() means the NEXT
    // call re-authenticates, full stop — even if a fetch predating the
    // invalidation is still in flight, a caller arriving after invalidate()
    // must not silently join it and receive a token the system already
    // decided to discard. They get their own fresh fetch instead.
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    const first = auth.getToken(); // fetch #1 in flight, pre-invalidation
    auth.invalidate();
    const second = auth.getToken(); // called AFTER invalidate() — must NOT join fetch #1

    const [firstToken, secondToken] = await Promise.all([first, second]);

    expect(mock.state.issuedTokens).toHaveLength(2);
    expect(firstToken).toBe(mock.state.issuedTokens[0]);
    expect(secondToken).toBe(mock.state.issuedTokens[1]);
    expect(secondToken).not.toBe(firstToken);
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

describe('OAuthClientCredentials — secret handling and malformed responses', () => {
  it('never leaks the client secret, raw or percent-encoded, into a thrown error', async () => {
    // A base64-alphabet secret: '+', '/', '=', '&' are exactly the characters
    // that differ between the raw secret and its query-string (percent-encoded)
    // form. Generated OAuth secrets overwhelmingly look like this — it's the
    // common case, not a corner case.
    const secret = 'a+b/c=d&e';
    const probe = await startProbeServer(({ url }) => ({
      status: 400,
      body: JSON.stringify({
        error: 'invalid_request',
        // Simulate a server that (unhelpfully) echoes the request URL back —
        // exactly as it appeared on the wire, i.e. percent-encoded — which is
        // the case redaction has to defend against.
        debug: `rejected request: ${url}`,
      }),
    }));
    try {
      const auth = new OAuthClientCredentials(probe.url, 'good-id', secret);
      let caught: unknown;
      try {
        await auth.getToken();
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
      const auth = new OAuthClientCredentials(probe.url, 'good-id', 'secret');
      let caught: unknown;
      try {
        await auth.getToken();
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

/**
 * openEQUELLA is very commonly deployed under a path prefix
 * (`https://library.example.edu/equella` is the vendor's own default in many
 * installs). `new URL('/oauth/access_token', 'https://host/oeq')` answers
 * `https://host/oauth/access_token` -- the prefix is gone, because an
 * absolute path replaces the base's path outright -- so at such a site every
 * token request went to a URL that does not exist.
 *
 * The assertion is on the URL the provider actually fetches, because that is
 * the only thing that would have caught it.
 */
describe('OAuthClientCredentials — an instance hosted under a path prefix', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const captureFetch = (): string[] => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ access_token: 'tok-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return seen;
  };

  it('requests the token under the prefix, not at the host root', async () => {
    const seen = captureFetch();
    const auth = new OAuthClientCredentials('https://library.example.edu/oeq', 'id', 'secret');
    expect(await auth.getToken()).toBe('tok-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith('https://library.example.edu/oeq/')).toBe(true);
    expect(new URL(seen[0]!).pathname).toBe('/oeq/oauth/access_token');
  });

  it('still hits the host root when there is no prefix', async () => {
    const seen = captureFetch();
    const auth = new OAuthClientCredentials('https://oeq.example.edu', 'id', 'secret');
    await auth.getToken();
    expect(new URL(seen[0]!).pathname).toBe('/oauth/access_token');
  });

  /** The error path names the endpoint too, and it must name the real one. */
  it('names the prefixed endpoint when the network fails, and still no query string', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const auth = new OAuthClientCredentials('https://library.example.edu/oeq', 'id', 'secret');
    const err = await auth.getToken().catch((e: unknown) => e);
    expect((err as ApiError).message).toContain('https://library.example.edu/oeq/oauth/access_token');
    expect((err as ApiError).message).not.toContain('client_secret');
  });
});
