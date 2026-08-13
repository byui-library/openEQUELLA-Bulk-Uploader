import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { UsernamePasswordAuth } from '../src/core/passwordAuth.js';

const BASE = 'https://oeq.example.edu';

/**
 * A sign-in is TWO requests now: the POST that establishes the session, and
 * the GET that confirms the session belongs to somebody. openEQUELLA answers
 * an unauthenticated request as the guest user with an ordinary 200, so a
 * cookie is not proof of anything on its own -- which is why every stub below
 * has to answer both, and why the counting assertions filter for the sign-in
 * itself rather than counting requests.
 */
const isLogin = (url: string) => new URL(url).pathname === '/api/auth/login';
const isVerify = (url: string) => new URL(url).pathname === '/api/content/currentuser';

/** What a real account looks like. `guest` is the field that decides. */
const REAL_USER = { id: 'u-1', username: 'jsmith', firstName: 'J', lastName: 'Smith', guest: false };

/** The real recorded response an UNAUTHENTICATED session gets: 200, not 401. */
const GUEST_USER: unknown = JSON.parse(
  readFileSync('tests/fixtures/api/currentuser-guest.json', 'utf8'),
);

const userResponse = (user: unknown = REAL_USER) =>
  new Response(JSON.stringify(user), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A fetch stub that returns a JSESSIONID cookie and counts its calls. */
function loginStub(cookie = 'abc123', user: unknown = REAL_USER) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL) => {
    calls.push(String(input));
    if (isVerify(String(input))) return userResponse(user);
    return new Response('', {
      status: 200,
      headers: { 'set-cookie': `JSESSIONID=${cookie}; Path=/; HttpOnly` },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/**
 * A fetch stub issuing a DISTINCT session per SIGN-IN, so a test can tell
 * which sign-in a given cookie came from. Needed for the generation tests
 * below -- a fixed cookie cannot distinguish "re-signed in" from "handed back
 * the stale one". Numbered by sign-ins rather than by requests so that the
 * confirmation request each sign-in makes does not shift the numbering.
 */
function sequentialLoginStub() {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL) => {
    calls.push(String(input));
    if (isVerify(String(input))) return userResponse();
    return new Response('', {
      status: 200,
      headers: {
        'set-cookie': `JSESSIONID=session-${calls.filter(isLogin).length}; Path=/; HttpOnly`,
      },
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
    expect(calls.filter(isLogin)).toHaveLength(1);
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
    expect(calls.filter(isLogin)).toHaveLength(2);
  });

  it('collapses concurrent sign-ins into one request', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await Promise.all([auth.authHeader(), auth.authHeader(), auth.authHeader()]);
    expect(calls.filter(isLogin)).toHaveLength(1);
  });

  /**
   * PART A. A 200 with a JSESSIONID is not proof of sign-in: the very bug this
   * closes was a login that returned 200, set cookies, and left the session
   * authenticated as `guest` -- and openEQUELLA reports that state with an
   * ordinary 200 on every subsequent request, never a 401. So a session that
   * cannot say who it belongs to must fail HERE, at sign-in, rather than
   * silently uploading nothing and reporting every duplicate check clean.
   */
  describe('confirming the session is somebody', () => {
    it('refuses a sign-in whose session the server answers as guest', async () => {
      const { impl } = loginStub('abc123', GUEST_USER);
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await expect(auth.authHeader()).rejects.toThrow(/does not recognise the session/i);
    });

    /** The message has to name the cause, not merely fail. */
    it('says the session belongs to nobody rather than blaming the password', async () => {
      const { impl } = loginStub('abc123', GUEST_USER);
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      const error = await auth.authHeader().catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/guest/i);
      expect((error as Error).message).toMatch(/nobody is signed in/i);
    });

    it('caches nothing, so the next caller signs in again rather than reusing a guest session', async () => {
      const { impl, calls } = loginStub('abc123', GUEST_USER);
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await expect(auth.getToken()).rejects.toThrow();
      await expect(auth.getToken()).rejects.toThrow();
      expect(calls.filter(isLogin)).toHaveLength(2);
    });

    it('signs in normally for a real user', async () => {
      const { impl } = loginStub();
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      expect(await auth.getToken()).toBe('abc123');
    });

    it('confirms with the session it just established, not a bare request', async () => {
      const seen: (string | null)[] = [];
      const impl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (isVerify(String(input))) {
          seen.push(new Headers(init?.headers).get('cookie'));
          return userResponse();
        }
        const headers = new Headers();
        headers.append('set-cookie', 'AWSALB=lb; Path=/');
        headers.append('set-cookie', 'JSESSIONID=abc123; Path=/; HttpOnly');
        return new Response('', { status: 200, headers });
      }) as unknown as typeof fetch;
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await auth.authHeader();
      // The WHOLE jar: JSESSIONID alone is what authenticated as guest against
      // the live instance, so confirming with it alone would fail every
      // sign-in for the same wrong reason.
      //
      // Sorted, because cookie order carries no meaning -- RFC 6265 says a
      // server must not depend on it -- so asserting it would couple this test
      // to readCookies()'s iteration order and break on a harmless change.
      // Still compared as whole pairs rather than with `toContain`, which
      // would also pass for `AWSALB=lb; Path=/`: attributes are a browser's
      // instructions and must never be echoed back.
      expect(seen).toHaveLength(1);
      expect((seen[0] ?? '').split('; ').sort()).toEqual(['AWSALB=lb', 'JSESSIONID=abc123']);
    });

    /** One request per sign-in. Not one per call, or a batch pays for it. */
    it('confirms once per sign-in, not once per call', async () => {
      const { impl, calls } = loginStub();
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await auth.authHeader();
      await auth.authHeader();
      await auth.getToken();
      expect(calls.filter(isVerify)).toHaveLength(1);
      expect(calls.filter(isLogin)).toHaveLength(1);
    });

    it('confirms again after invalidate, because that session is a new one', async () => {
      const { impl, calls } = loginStub();
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await auth.authHeader();
      auth.invalidate();
      await auth.authHeader();
      expect(calls.filter(isVerify)).toHaveLength(2);
    });

    /**
     * A confirmation that could not be made is not a confirmation. Accepting
     * an unreadable answer would restore exactly the assumption this check
     * exists to remove: that a 200 means somebody is signed in.
     */
    it('refuses a sign-in it could not confirm at all', async () => {
      // 200, but HTML: an SSO portal or a proxy answering in openEQUELLA's
      // place. Nothing here says who the session is.
      const impl = vi.fn(async (input: string | URL) => {
        if (isVerify(String(input))) return new Response('<html>a login page</html>', { status: 200 });
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/; HttpOnly' },
        });
      }) as unknown as typeof fetch;
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await expect(auth.authHeader()).rejects.toThrow(/could not confirm/i);
    });

    it('refuses a sign-in whose confirmation the server rejected', async () => {
      const impl = vi.fn(async (input: string | URL) => {
        if (isVerify(String(input))) return new Response('nope', { status: 403 });
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/; HttpOnly' },
        });
      }) as unknown as typeof fetch;
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await expect(auth.authHeader()).rejects.toThrow(/could not confirm/i);
    });
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
    expect(calls.filter(isLogin)).toHaveLength(2);

    // And that one WAS cached, so a third call makes no request.
    expect(await auth.getToken()).toBe('session-2');
    expect(calls.filter(isLogin)).toHaveLength(2);
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

    expect(calls.filter(isLogin)).toHaveLength(2);
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
    await expect(auth.authHeader()).rejects.toThrow(/did not return a session/i);
  });

  /**
   * openEQUELLA routinely sets several cookies, so a lone Set-Cookie header is
   * the UNREALISTIC case. Built with two append() calls because that is what a
   * real multi-cookie response looks like -- and note `headers.get()` would
   * comma-join these into one unparseable string, which is why the
   * implementation uses getSetCookie().
   */
  function multiCookieStub(cookies: string[]) {
    const impl = vi.fn(async (input: string | URL) => {
      if (isVerify(String(input))) return userResponse();
      const headers = new Headers();
      for (const c of cookies) headers.append('set-cookie', c);
      return new Response('', { status: 200, headers });
    });
    return impl as unknown as typeof fetch;
  }

  it('finds JSESSIONID when it is not the first Set-Cookie header', async () => {
    const impl = multiCookieStub(['other=1; Path=/', 'JSESSIONID=xyz; Path=/; HttpOnly']);
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    // Both cookies come back -- see the `cookie jar` block below -- but the
    // point here is that the session was found in the SECOND header, so an
    // implementation reading only the first would throw instead.
    expect(await auth.getToken()).toBe('xyz');
    expect((await auth.authHeader()).Cookie).toContain('JSESSIONID=xyz');
  });

  /**
   * The decoy is what makes an exact-name match earn its place: a substring
   * match would take 'nope' as the session and every later request would 401.
   *
   * The decoy cookie is itself carried in the Cookie header, which is correct
   * -- a browser would send it back too, and the server set it for a reason.
   * What must not happen is it being MISTAKEN for the session, so this asserts
   * on the session value rather than on the jar.
   */
  it('is not fooled by a cookie whose name merely ends in JSESSIONID', async () => {
    const impl = multiCookieStub(['MYJSESSIONID=nope; Path=/', 'JSESSIONID=yes; Path=/']);
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    expect(await auth.getToken()).toBe('yes');
  });

  /**
   * A cookie whose name merely ENDS in JSESSIONID is not a session, so a
   * response carrying only that one established nothing. Without the
   * `(?:^|;\s*)` anchor this is accepted and 'nope' is sent as the session --
   * the same defect as the test above, but with no real cookie present to
   * mask it, so it fails on the error rather than on the value.
   */
  it('does not accept MYJSESSIONID alone as a session', async () => {
    const impl = multiCookieStub(['MYJSESSIONID=nope; Path=/']);
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await expect(auth.authHeader()).rejects.toThrow(/did not return a session/i);
  });

  /**
   * The whole cookie jar, not just JSESSIONID.
   *
   * MEASURED against https://content-test.byui.edu on 2026-08-12 with a real
   * account. One sign-in response set four cookies -- AWSALB, AWSALBCORS,
   * JSESSIONID and ROUTEID -- and the identity the instance then reported
   * depended entirely on which of them were sent back:
   *
   *   JSESSIONID alone -> username=guest,  guest=true
   *   all four         -> username=milesm, guest=false
   *
   * The instance is behind an AWS load balancer; AWSALB and ROUTEID carry the
   * routing state that lands a request on the backend holding the session.
   * Without them the request reaches a backend that has never seen it -- and
   * openEQUELLA does not answer that with a 401. It serves it as guest, 200,
   * with empty-but-plausible data, which is why this was invisible: the
   * desktop app's collection list simply looked empty.
   */
  describe('cookie jar', () => {
    /** The four cookies exactly as the live instance set them, values elided
     *  to the measured lengths. */
    const LIVE_SET_COOKIES = [
      `AWSALB=${'a'.repeat(124)}; Expires=Wed, 19 Aug 2026 17:02:11 GMT; Path=/`,
      `AWSALBCORS=${'b'.repeat(124)}; Expires=Wed, 19 Aug 2026 17:02:11 GMT; Path=/; SameSite=None; Secure`,
      `JSESSIONID=${'0123456789abcdef0123456789abcdef'}; Path=/; HttpOnly`,
      `ROUTEID=.1; Path=/`,
    ];

    it('sends back every cookie the sign-in set, not just JSESSIONID', async () => {
      const auth = new UsernamePasswordAuth(
        BASE,
        'jsmith',
        'hunter2',
        multiCookieStub(LIVE_SET_COOKIES),
      );
      const cookie = (await auth.authHeader()).Cookie ?? '';
      // Sorted: which cookies are present is the point, the order they sit in
      // is not. RFC 6265 says a server must not depend on it.
      const names = cookie.split('; ').map((pair) => pair.split('=')[0]).sort();
      expect(names).toEqual(['AWSALB', 'AWSALBCORS', 'JSESSIONID', 'ROUTEID']);
    });

    /**
     * Path, Expires, HttpOnly, Secure and SameSite are instructions to a
     * browser about how to STORE a cookie. Echoing them back turns each into
     * a bogus extra cookie named `Path`, `Expires`, ... and some servers
     * reject the header outright.
     */
    it('emits name=value pairs joined by "; " and no cookie attributes', async () => {
      const auth = new UsernamePasswordAuth(
        BASE,
        'jsmith',
        'hunter2',
        multiCookieStub(LIVE_SET_COOKIES),
      );
      const cookie = (await auth.authHeader()).Cookie;
      // Compared as a sorted set of whole pairs: this test is about FORMAT --
      // `name=value`, joined by '; ', with no attributes -- and order is not
      // part of that. An attribute leaking through would appear as its own
      // element here and fail, which is the property worth keeping.
      expect((cookie ?? '').split('; ').sort()).toEqual(
        [
          `AWSALB=${'a'.repeat(124)}`,
          `AWSALBCORS=${'b'.repeat(124)}`,
          `JSESSIONID=0123456789abcdef0123456789abcdef`,
          `ROUTEID=.1`,
        ].sort(),
      );
      for (const attribute of ['Path', 'Expires', 'HttpOnly', 'Secure', 'SameSite']) {
        expect(cookie).not.toContain(attribute);
      }
    });

    /** The simple case must not regress: one cookie in, one cookie out. */
    it('handles a response that set only JSESSIONID', async () => {
      const auth = new UsernamePasswordAuth(
        BASE,
        'jsmith',
        'hunter2',
        multiCookieStub(['JSESSIONID=only; Path=/; HttpOnly']),
      );
      expect(await auth.authHeader()).toEqual({ Cookie: 'JSESSIONID=only' });
    });

    /**
     * Keeping the jar must not weaken the JSESSIONID requirement. Routing
     * cookies alone prove nothing: they say which backend to talk to, not
     * that a session exists on it. A 200 carrying only those is exactly the
     * "authenticated-looking but not authenticated" state the check exists
     * to catch.
     */
    it('still rejects a 200 whose cookies include no JSESSIONID', async () => {
      const auth = new UsernamePasswordAuth(
        BASE,
        'jsmith',
        'hunter2',
        multiCookieStub([`AWSALB=${'a'.repeat(124)}; Path=/`, 'ROUTEID=.1; Path=/']),
      );
      await expect(auth.authHeader()).rejects.toThrow(/did not return a session/i);
    });

    /**
     * A stale AWSALB pins requests to the backend of a session that is gone.
     * Merging jars would keep it alive past the invalidate() that was
     * supposed to end it, so the replacement has to be wholesale.
     */
    it('replaces the whole jar on re-sign-in rather than merging with the old one', async () => {
      let signIn = 0;
      const impl = vi.fn(async (input: string | URL) => {
        if (isVerify(String(input))) return userResponse();
        signIn += 1;
        const headers = new Headers();
        headers.append('set-cookie', `AWSALB=lb-${signIn}; Path=/`);
        headers.append('set-cookie', `JSESSIONID=session-${signIn}; Path=/; HttpOnly`);
        // Only the first sign-in sets ROUTEID; the second must not inherit it.
        if (signIn === 1) headers.append('set-cookie', 'ROUTEID=.1; Path=/');
        return new Response('', { status: 200, headers });
      }) as unknown as typeof fetch;

      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      // Sorted, like the other jar assertions: the point is WHICH cookies
      // survive a re-sign-in, not the order they sit in. The second jar must
      // not carry ROUTEID -- that is the merge this test exists to forbid.
      const jar = async () => ((await auth.authHeader()).Cookie ?? '').split('; ').sort();

      expect(await jar()).toEqual(['AWSALB=lb-1', 'JSESSIONID=session-1', 'ROUTEID=.1']);

      auth.invalidate();
      expect(await jar()).toEqual(['AWSALB=lb-2', 'JSESSIONID=session-2']);
    });
  });

  /**
   * Clearing the local token store is a complete logout under OAuth, where the
   * token IS the session. Under password auth it is not: the JSESSIONID stays
   * valid ON THE SERVER until openEQUELLA times it out, so "logged out" is a
   * claim this tool has not earned until it has asked the server to end it.
   */
  describe('logout', () => {
    /** Records what each request actually was, not just where it went. */
    function recordingStub() {
      const seen: { method: string; path: string; cookie: string | null }[] = [];
      const impl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          method: init?.method ?? 'GET',
          path: new URL(String(input)).pathname,
          cookie: headers.get('cookie'),
        });
        if (isVerify(String(input))) return userResponse();
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/; HttpOnly' },
        });
      });
      return { impl: impl as unknown as typeof fetch, seen };
    }

    it('asks the server to end the session, after signing in', async () => {
      const { impl, seen } = recordingStub();
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await auth.authHeader();
      await auth.logout();

      // The GET in the middle is the sign-in confirming who it signed in as.
      expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
        'POST /api/auth/login',
        'GET /api/content/currentuser',
        'PUT /api/auth/logout',
      ]);
    });

    /**
     * The cookie is the whole request. A PUT without it ends nothing, and the
     * server would answer 200 to it just the same -- so a test that only
     * counted the call would pass against a logout that did nothing at all.
     */
    it('presents the session it is ending', async () => {
      const { impl, seen } = recordingStub();
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await auth.authHeader();
      await auth.logout();

      expect(seen.find((r) => r.path.endsWith('/logout'))?.cookie).toBe('JSESSIONID=abc123');
    });

    /**
     * A logout that fails is not worth interrupting anyone over: the local
     * session is dropped either way and openEQUELLA times the server one out
     * regardless. Throwing would make `oeq-upload logout` fail on a flaky
     * network having already done the part that matters.
     */
    it('resolves even when the request fails, and still drops the local session', async () => {
      const calls: string[] = [];
      const impl = vi.fn(async (input: string | URL) => {
        calls.push(String(input));
        if (String(input).includes('/logout')) throw new Error('connect ECONNREFUSED');
        if (isVerify(String(input))) return userResponse();
        return new Response('', {
          status: 200,
          headers: {
            'set-cookie': `JSESSIONID=session-${calls.filter(isLogin).length}; Path=/; HttpOnly`,
          },
        });
      }) as unknown as typeof fetch;

      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await auth.getToken();
      await expect(auth.logout()).resolves.toBeUndefined();

      // Locally gone regardless: the next caller signs in afresh rather than
      // being handed the session this process just tried to end. Sessions are
      // numbered by sign-in, so this is the SECOND one -- a different session
      // from the one logout tried to end, which is the whole assertion.
      expect(await auth.getToken()).toBe('session-2');
    });

    it('makes no request at all when there was never a session', async () => {
      const { impl, seen } = recordingStub();
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await auth.logout();
      expect(seen).toEqual([]);
    });

    it('makes no second request when called twice', async () => {
      const { impl, seen } = recordingStub();
      const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
      await auth.authHeader();
      await auth.logout();
      await auth.logout();
      expect(seen.filter((r) => r.path.endsWith('/logout'))).toHaveLength(1);
    });
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

  /**
   * Sign-in genuinely carries the password in the query string -- that is
   * openEQUELLA's API, not a choice made here, and it is why nothing else may.
   * Logging out identifies the session by its cookie and has no reason to name
   * a credential, so a URL built the same way as the sign-in one would put the
   * password in a second set of server access logs for nothing.
   */
  it('is absent from the logout request, which needs no credential at all', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', SECRET, impl);
    await auth.authHeader();
    await auth.logout();

    // Everything the sign-in itself is not: the confirmation GET and the
    // logout PUT. Neither has any business naming a credential.
    const afterSignIn = calls.filter((c) => !isLogin(c));
    expect(afterSignIn.map((c) => new URL(c).pathname)).toEqual([
      '/api/content/currentuser',
      '/api/auth/logout',
    ]);
    expect(findsSecret(afterSignIn)).toBe(false);
    // And in no request's PATH, where even the sign-in must keep it out.
    expect(findsSecret(calls.map((c) => new URL(c).pathname))).toBe(false);
  });
});

/**
 * openEQUELLA is very commonly deployed under a path prefix
 * (`https://library.example.edu/equella` is the vendor's own default in many
 * installs), and `normaliseInstanceUrl` deliberately keeps one. Every URL
 * this class built then threw it away again, because `new URL(path, base)`
 * with an absolute `path` replaces the base's path outright -- so at such a
 * site sign-in, confirmation and logout all went to the host root.
 *
 * The assertions are on the URLs the provider actually fetches. Nothing
 * short of that would have caught it.
 */
describe('UsernamePasswordAuth — an instance hosted under a path prefix', () => {
  const PREFIXED = 'https://library.example.edu/oeq';

  /** As above, but keyed to the prefixed paths. */
  const prefixedStub = () => {
    const calls: string[] = [];
    const impl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (new URL(url).pathname.endsWith('/api/content/currentuser')) return userResponse();
      return new Response('', {
        status: 200,
        headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/; HttpOnly' },
      });
    });
    return { impl: impl as unknown as typeof fetch, calls };
  };

  it('signs in, confirms and logs out entirely under the prefix', async () => {
    const { impl, calls } = prefixedStub();
    const auth = new UsernamePasswordAuth(PREFIXED, 'jsmith', 'hunter2', impl);
    await auth.authHeader();
    await auth.logout();

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.startsWith('https://library.example.edu/oeq/')).toBe(true);
    }
    expect(calls.map((c) => new URL(c).pathname)).toEqual([
      '/oeq/api/auth/login',
      '/oeq/api/content/currentuser',
      '/oeq/api/auth/logout',
    ]);
  });

  it('still hits the host root when there is no prefix', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await auth.authHeader();
    await auth.logout();
    expect(calls.map((c) => new URL(c).pathname)).toEqual([
      '/api/auth/login',
      '/api/content/currentuser',
      '/api/auth/logout',
    ]);
  });

  it('names the prefixed endpoint when the network fails, and never the password', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(PREFIXED, 'jsmith', 'hunter2', impl);
    const err = await auth.authHeader().catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('https://library.example.edu/oeq/api/auth/login');
    expect((err as Error).message).not.toContain('hunter2');
    expect((err as Error).message).not.toContain('?');
  });
});
