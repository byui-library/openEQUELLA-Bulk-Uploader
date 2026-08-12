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

/**
 * A fetch stub issuing a DISTINCT session per call, so a test can tell which
 * sign-in a given cookie came from. Needed for the generation tests below --
 * a fixed cookie cannot distinguish "re-signed in" from "handed back the
 * stale one".
 */
function sequentialLoginStub() {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL) => {
    calls.push(String(input));
    return new Response('', {
      status: 200,
      headers: { 'set-cookie': `JSESSIONID=session-${calls.length}; Path=/; HttpOnly` },
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

  /**
   * The concrete failure this prevents: a sign-in is in flight when client.ts
   * hits a 401 and calls invalidate(). If that sign-in then caches its result,
   * the cache holds a JSESSIONID minted against the session the server already
   * rejected. The single permitted retry goes out with that same dead cookie,
   * 401s again, and the batch dies -- the client will not retry a second time.
   */
  it('discards (does not cache) a session whose sign-in was invalidated mid-flight', async () => {
    const { impl, calls } = sequentialLoginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    const first = auth.getToken(); // sign-in #1 starts, not yet resolved
    auth.invalidate(); // lands while sign-in #1 is in flight
    expect(await first).toBe('session-1'); // caller still gets a usable session

    // But it must NOT have been cached, so the next call signs in afresh.
    expect(await auth.getToken()).toBe('session-2');
    expect(calls).toHaveLength(2);

    // And that one WAS cached, so a third call makes no request.
    expect(await auth.getToken()).toBe('session-2');
    expect(calls).toHaveLength(2);
  });

  /**
   * invalidate() means the NEXT call re-authenticates, full stop. A caller
   * arriving after it must not silently join a sign-in that predates it and
   * receive a session the system already decided to discard.
   */
  it('does not hand an invalidated in-flight session to a caller arriving after invalidate', async () => {
    const { impl, calls } = sequentialLoginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    const first = auth.getToken(); // sign-in #1 in flight, pre-invalidation
    auth.invalidate();
    const second = auth.getToken(); // called AFTER invalidate() -- must not join #1

    const [firstSession, secondSession] = await Promise.all([first, second]);

    expect(calls).toHaveLength(2);
    expect(firstSession).toBe('session-1');
    expect(secondSession).toBe('session-2');
    expect(secondSession).not.toBe(firstSession);
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
  /**
   * Deliberately contains `!` and a space. Both are what make the three
   * encodings disagree, and `!` is the most common special character in
   * institutional password policies. An all-unreserved password (the earlier
   * `correct-horse-battery-staple`) encodes to itself under every encoder, so
   * it cannot tell a working redactor from a broken one.
   */
  const SECRET = 'Summer2026!pa ss';

  /**
   * The three forms the password can appear in, written out literally rather
   * than computed with the same helper the implementation uses -- otherwise a
   * bug in that helper would be mirrored here and the test would agree with
   * the defect instead of catching it.
   */
  const SECRET_FORMS = [
    'Summer2026!pa ss', // literal
    'Summer2026!pa%20ss', // encodeURIComponent
    'Summer2026%21pa+ss', // URLSearchParams, i.e. what actually goes on the wire
  ];

  /**
   * Walks every string reachable from a thrown error -- message, stack,
   * ApiError's body field, and anything nested -- looking for the password in
   * any of its wire forms. It travels in a query string, so a URL echoed back
   * by the server carries an encoded form, not the literal one.
   */
  const findsSecret = (value: unknown): boolean => {
    const seen = new Set<unknown>();
    const walk = (v: unknown): boolean => {
      if (v == null || seen.has(v)) return false;
      seen.add(v);
      if (typeof v === 'string') {
        return SECRET_FORMS.some((form) => v.includes(form));
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

  /**
   * Guards the hardcoded constants above. If they ever stop matching what the
   * encoders actually produce, every test in this block silently starts
   * looking for a string that can never appear.
   */
  it('has honest fixtures: the three forms really are distinct and correct', () => {
    const url = new URL('https://oeq.example.edu/api/auth/login');
    url.searchParams.set('password', SECRET);
    expect(SECRET_FORMS).toEqual([
      SECRET,
      encodeURIComponent(SECRET),
      url.searchParams.toString().replace('password=', ''),
    ]);
    expect(new Set(SECRET_FORMS).size).toBe(3);
  });

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
