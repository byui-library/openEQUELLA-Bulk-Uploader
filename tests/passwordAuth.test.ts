import { describe, it, expect, vi } from 'vitest';
import { UsernamePasswordAuth } from '../src/core/passwordAuth.js';

const BASE = 'https://oeq.example.edu';

/** A fetch stub that returns a JSESSIONID cookie and counts its calls. */
function loginStub(cookie = 'abc123') {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL) => {
    calls.push(String(input));
    return new Response('', {
      status: 200,
      headers: { 'set-cookie': `JSESSIONID=${cookie}; Path=/; HttpOnly` },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('UsernamePasswordAuth', () => {
  it('signs in and presents the session as a Cookie header', async () => {
    const { impl } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    expect(await auth.authHeader()).toEqual({ Cookie: 'JSESSIONID=abc123' });
  });

  it('signs in once and reuses the session', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await auth.authHeader();
    await auth.authHeader();
    expect(calls).toHaveLength(1);
  });

  /**
   * The client retries once on 401 after calling invalidate(). That is the
   * ONLY mechanism handling an expired session, so it has to actually
   * re-login rather than hand back the dead cookie.
   */
  it('signs in again after invalidate', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await auth.authHeader();
    auth.invalidate();
    await auth.authHeader();
    expect(calls).toHaveLength(2);
  });

  it('collapses concurrent sign-ins into one request', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await Promise.all([auth.authHeader(), auth.authHeader(), auth.authHeader()]);
    expect(calls).toHaveLength(1);
  });

  it('reports bad credentials without echoing the password', async () => {
    const impl = vi.fn(async () =>
      new Response('Bad credentials for hunter2', { status: 401 }),
    ) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await expect(auth.authHeader()).rejects.toThrow(/sign-in failed/i);
    await auth.authHeader().catch((e: Error) => {
      expect(JSON.stringify(e)).not.toContain('hunter2');
      expect(e.message).not.toContain('hunter2');
    });
  });

  /**
   * A 200 with no cookie means we are not authenticated but would look it.
   * Every later request would 401 with no explanation.
   */
  it('rejects a 200 that carried no session cookie', async () => {
    const impl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await expect(auth.authHeader()).rejects.toThrow(/no session/i);
  });

  it('refuses to be constructed against a plaintext instance', () => {
    const { impl } = loginStub();
    expect(() => new UsernamePasswordAuth('http://oeq.example.edu', 'j', 'p', impl)).toThrow(
      /https/i,
    );
  });
});

describe('the password never escapes', () => {
  const SECRET = 'correct-horse-battery-staple';

  /**
   * Walks every string reachable from a thrown error -- message, stack,
   * ApiError's body field, and anything nested -- looking for the password
   * in either literal or percent-encoded form. It travels in a query string,
   * so a URL echoed back by the server carries the encoded form.
   */
  const findsSecret = (value: unknown): boolean => {
    const seen = new Set<unknown>();
    const walk = (v: unknown): boolean => {
      if (v == null || seen.has(v)) return false;
      seen.add(v);
      if (typeof v === 'string') {
        return v.includes(SECRET) || v.includes(encodeURIComponent(SECRET));
      }
      if (v instanceof Error) {
        // Own enumerable properties matter as much as the built-ins: ApiError
        // carries the server's response in `body`, and `message`/`stack`/
        // `cause` alone would miss it entirely. Checked by mutation -- with
        // redact() neutered this branch is what goes red.
        return (
          walk(v.message) ||
          walk(v.stack) ||
          walk(v.cause) ||
          Object.values(v as unknown as object).some(walk)
        );
      }
      if (typeof v === 'object') return Object.values(v as object).some(walk);
      return false;
    };
    return walk(value);
  };

  it('is absent from a rejected sign-in, including the echoed body', async () => {
    const impl = vi.fn(
      async (input: string | URL) =>
        // A server echoing the request line back is exactly how the encoded
        // form leaks.
        new Response(`Rejected request: ${String(input)}`, { status: 401 }),
    ) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', SECRET, impl);
    const error = await auth.authHeader().catch((e: unknown) => e);
    expect(findsSecret(error)).toBe(false);
  });

  it('is absent when the network fails before a response', async () => {
    const impl = vi.fn(async (input: string | URL) => {
      throw new Error(`connect ECONNREFUSED for ${String(input)}`);
    }) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', SECRET, impl);
    const error = await auth.authHeader().catch((e: unknown) => e);
    expect(findsSecret(error)).toBe(false);
  });

  it('is absent from the Cookie header handed to the client', async () => {
    const { impl } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', SECRET, impl);
    expect(findsSecret(await auth.authHeader())).toBe(false);
  });
});
