import { ApiError } from './errors.js';
import type { AuthProvider } from './auth.js';
import { GUEST_SESSION_EXPLANATION } from './identity.js';
import { instanceEndpoint, normaliseInstanceUrl } from './instanceUrl.js';
import { redactSecret } from './redact.js';
import { SingleFlight } from './singleFlight.js';

/**
 * openEQUELLA's own username/password sign-in.
 *
 * This is the default for institutions that are not behind SSO. It posts to
 * `/api/auth/login` and keeps EVERY cookie the response set, presenting them
 * as a Cookie header so `client.ts` needs no changes: the client merges
 * whatever `authHeader()` returns into every request.
 *
 * KEEPING THE WHOLE JAR IS NOT OPTIONAL. Measured against
 * https://content-test.byui.edu on 2026-08-12 with a real account: the
 * sign-in response set AWSALB, AWSALBCORS, JSESSIONID and ROUTEID. Sending
 * JSESSIONID back on its own authenticated as `guest`; sending all four
 * authenticated as the real user. The instance sits behind an AWS load
 * balancer, and AWSALB/ROUTEID are the routing state that lands a request on
 * the backend actually holding the session -- without them it reaches one
 * that has never seen it. openEQUELLA does not answer that with a 401. It
 * serves it as guest, 200, with empty-but-plausible data, so the failure is
 * silent: the desktop app's collection list simply looked empty.
 *
 * A SESSION IS NOT SIGNED IN UNTIL IT SAYS WHO IT IS. `login()` therefore
 * spends one more request confirming the session it just established --
 * `GET /api/content/currentuser`, `guest !== true` -- and throws when it does
 * not. "200 plus a JSESSIONID" was the old proof of sign-in, and the bug
 * above is what it is worth: the login returned 200, set cookies, and the
 * session was guest. openEQUELLA never answers that with a 401, so without
 * this check the failure surfaces nowhere. One request per sign-in, not per
 * call -- it lives inside login(), which runs once per session.
 *
 * SESSION EXPIRY IS NOT HANDLED HERE, and cannot be handled by a 401: this
 * instance answers a lapsed session with 200 and guest data. `client.ts` does
 * invalidate-and-retry-once on 401, which fires under OAuth but effectively
 * never under password auth. The layer that must not be fooled by a stale
 * session is the duplicate check, and it verifies identity itself, once per
 * batch (see duplicates.ts#findDuplicates). See the long comment in auth.ts
 * for why expiry is reactive rather than on a timer.
 *
 * THE PASSWORD TRAVELS IN THE QUERY STRING. That is openEQUELLA's API, not a
 * choice made here. It means the password reaches server access logs, so:
 * https is required (enforced in the constructor), and nothing in this class
 * ever puts a full URL into an error, a message or a log line.
 */
/** Shared by the request and by safeEndpoint(), so an error can never name an
 *  endpoint the code did not actually call. */
const LOGIN_PATH = '/api/auth/login';
/** Confirmed in the captured schema/swagger.json. PUT, and it takes no body. */
const LOGOUT_PATH = '/api/auth/logout';
/** CONFIRMED in schema/swagger.json and measured live: the one endpoint that
 *  answers "who is this session", and the only way to tell a real sign-in from
 *  a guest one -- see the guest fixture in tests/fixtures/api/. */
const CURRENT_USER_PATH = '/api/content/currentuser';

/**
 * One established session: the cookies to send back, plus the JSESSIONID
 * value pulled out of them.
 *
 * The two are kept together deliberately. They must always come from the SAME
 * sign-in response -- a JSESSIONID paired with another session's routing
 * cookies is worse than either alone, because it looks valid and routes to a
 * backend that will treat it as a guest.
 */
interface Session {
  /** JSESSIONID's value. Proof a session was established, and what
   *  `getToken()` returns. */
  readonly id: string;
  /** Every cookie from the sign-in response, ready to use as a Cookie header:
   *  `name=value` pairs joined by `'; '`, in the order the server set them. */
  readonly jar: string;
}

export class UsernamePasswordAuth implements AuthProvider {
  /**
   * The signed-in session: produced at most once at a time, dropped by
   * invalidate(). Every subtlety -- collapsing concurrent sign-ins, refusing
   * to cache one that was invalidated mid-flight, refusing to let a caller
   * arriving after invalidate() join an older sign-in -- lives in
   * SingleFlight, shared with OAuthClientCredentials in auth.ts.
   */
  private readonly flight = new SingleFlight<Session>(() => this.login());
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normaliseInstanceUrl(baseUrl);
  }

  /**
   * The JSESSIONID value, NOT the cookie jar.
   *
   * `AuthProvider.getToken()` means "the credential identifying this session"
   * across all three providers, and under password auth that is JSESSIONID --
   * the routing cookies alongside it identify a backend, not a session, and
   * are meaningless to a caller. Callers use it that way: `preflight.ts` only
   * awaits it to force a sign-in, and nothing outside this class builds a
   * request header from it. `authHeader()` is the single place that knows a
   * session is carried by a whole jar, and it reads the jar directly.
   */
  async getToken(): Promise<string> {
    return (await this.getSession()).id;
  }

  private getSession(): Promise<Session> {
    return this.flight.get();
  }

  private async login(): Promise<Session> {
    const url = instanceEndpoint(this.baseUrl, LOGIN_PATH);
    url.searchParams.set('username', this.username);
    url.searchParams.set('password', this.password);

    let res: Response;
    let body: string;
    try {
      res = await this.fetchImpl(url, { method: 'POST' });
      body = await res.text();
    } catch {
      // Never include the request URL: it carries the password, and some
      // runtimes fold the failing URL into the error's message or cause.
      // Deliberately vague about WHERE this failed -- it covers both the
      // fetch and the res.text() that follows it, and "check the address and
      // your network" is the same advice either way.
      throw new ApiError(
        `Could not reach ${this.safeEndpoint()}. Check the address and your network connection.`,
        0,
        '',
      );
    }

    if (!res.ok) {
      throw new ApiError(
        this.redact(`Sign-in failed (${res.status}). Check the username and password.`),
        res.status,
        this.redact(body),
      );
    }

    const cookies = readCookies(res.headers);
    // JSESSIONID specifically, not merely "some cookies": a load balancer
    // hands out AWSALB and ROUTEID to anyone, so a jar without JSESSIONID
    // proves no session was established.
    const id = cookies.get('JSESSIONID');
    if (!id) {
      throw new ApiError(
        'Signed in, but the site did not return a session. ' +
          'The address may not be an openEQUELLA site.',
        res.status,
        '',
      );
    }

    const session: Session = {
      id,
      jar: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    };

    // BEFORE returning, so before this session can be cached or handed to any
    // caller. A guest session that reached the cache would be presented as a
    // valid one for the rest of the process, and every request made with it
    // would come back 200. Throwing here means SingleFlight caches nothing.
    await this.confirmSignedIn(session);

    return session;
  }

  /**
   * Confirm the session just established belongs to a real user, and throw if
   * it does not.
   *
   * WHY THIS COSTS A REQUEST AND IS WORTH IT. Sign-in used to be judged by
   * "200 with a JSESSIONID", which is satisfied by a session authenticated as
   * `guest`: measured against content-test.byui.edu, sending back JSESSIONID
   * alone did exactly that. Nothing downstream can notice -- openEQUELLA
   * answers a guest request with 200 and empty-but-plausible data, never a
   * 401 -- so the alternative to one request here is a whole run that uploads
   * nothing and reports every duplicate check clean.
   *
   * An answer that cannot be READ is not a confirmation either. A non-2xx, an
   * unreachable server, or a body that is not the expected JSON all mean the
   * same thing: nobody has established who this session is. Accepting any of
   * them would restore the assumption this method exists to remove.
   *
   * The whole jar goes with it, exactly as `authHeader()` would send it. A
   * confirmation carrying only JSESSIONID would be answered as guest by the
   * live instance and fail every sign-in for the wrong reason.
   */
  private async confirmSignedIn(session: Session): Promise<void> {
    const url = instanceEndpoint(this.baseUrl, CURRENT_USER_PATH);
    let res: Response;
    let body: string;
    try {
      res = await this.fetchImpl(url, { headers: { Cookie: session.jar } });
      body = await res.text();
    } catch {
      throw new ApiError(
        `Signed in, but could not confirm who the session belongs to: ${url.origin}` +
          `${url.pathname} could not be reached. Check the address and your network connection.`,
        0,
        '',
      );
    }

    if (!res.ok) {
      throw new ApiError(
        `Signed in, but could not confirm who the session belongs to (${res.status} from ` +
          `${url.pathname}). The address may not be an openEQUELLA site.`,
        res.status,
        this.redact(body),
      );
    }

    let user: unknown;
    try {
      user = JSON.parse(body);
    } catch {
      throw new ApiError(
        `Signed in, but could not confirm who the session belongs to: ${url.pathname} did not ` +
          'answer with an account. The address may not be an openEQUELLA site.',
        res.status,
        this.redact(body),
      );
    }

    // `=== true` and not truthiness: a response that does not mention `guest`
    // is a real account, which is how client.ts reads it too.
    if ((user as { guest?: unknown } | null)?.guest === true) {
      throw new ApiError(
        'Signed in, but the site does not recognise the session as anybody. ' +
          GUEST_SESSION_EXPLANATION,
        res.status,
        '',
      );
    }
  }

  /** Origin + path only — never the query string, which carries the password.
   *  `pathname` (not `origin` alone) is what keeps a hosting prefix here: this
   *  must name the endpoint the code actually called. */
  private safeEndpoint(): string {
    const url = instanceEndpoint(this.baseUrl, LOGIN_PATH);
    return `${url.origin}${url.pathname}`;
  }

  private redact(text: string): string {
    return redactSecret(text, this.password);
  }

  async authHeader(): Promise<Record<string, string>> {
    return { Cookie: (await this.getSession()).jar };
  }

  invalidate(): void {
    this.flight.invalidate();
  }

  /**
   * End the session server-side as well as locally.
   *
   * Never throws. A logout that fails is not worth interrupting anyone over --
   * the local session is dropped either way, and openEQUELLA times the server
   * one out regardless. Throwing here would make `oeq-upload logout` fail on a
   * flaky network having already done the part that matters.
   *
   * The local drop happens FIRST, and unconditionally. This side is the one
   * this process can be certain of, so it must not be made to wait on a
   * request that may hang: an operator who asked to log out has logged out.
   * The captured session is then presented explicitly rather than through
   * `authHeader()`, which would sign in again -- invalidate() has already run
   * by then, so asking for a header would mint a NEW session and immediately
   * ask the server to end it, leaving the real one alive.
   *
   * No session means no request. There is nothing on the server to end, and a
   * PUT carrying no cookie would either be rejected or, worse, end some
   * unrelated session the runtime attached a cookie jar to.
   */
  async logout(): Promise<void> {
    // peek(), not getSession(): this must act on a session that already
    // exists and must never establish one. See the doc comment.
    const session = this.flight.peek();
    this.invalidate();
    if (!session) return;

    try {
      await this.fetchImpl(instanceEndpoint(this.baseUrl, LOGOUT_PATH), {
        method: 'PUT',
        // The whole jar, for the same reason every other request carries it:
        // without the routing cookies the PUT reaches a backend that does not
        // hold this session, and ends nothing.
        headers: { Cookie: session.jar },
      });
    } catch {
      // Deliberately empty -- see the doc comment. A non-2xx response is
      // ignored for the same reason: the body would say nothing this process
      // can act on.
    }
  }
}

/**
 * Read every cookie the response set, as name -> value, in the order the
 * server set them.
 *
 * `getSetCookie()` and not `get('set-cookie')`: a response sets several
 * cookies, and `get()` returns them comma-joined into one string, which both
 * defeats the `(?:^|;\s*)` anchor below and makes an individual cookie
 * impossible to isolate -- an `Expires=Wed, 19 Aug 2026 ...` attribute
 * contains a comma of its own, so the joined string cannot even be split back
 * apart reliably. `getSetCookie()` has existed since Node 19.7 and this module
 * only ever runs in a Node 22 process, so there is nothing to fall back to.
 *
 * Only the leading `name=value` of each header is kept. Everything after the
 * first `;` -- Path, Expires, HttpOnly, Secure, SameSite -- tells a BROWSER
 * how to store the cookie and is never sent back; echoing those would turn
 * each into a bogus cookie named `Path`, `Expires`, and so on.
 *
 * The decoy this must survive is `MYJSESSIONID=nope`, which a substring search
 * for `JSESSIONID=` accepts as the session. The old code fended that off with
 * the `(?:^|;\s*)` anchor on a JSESSIONID-specific pattern. What defeats it
 * now is the exact-key `jar.get('JSESSIONID')` in login(): the NAME is
 * captured and compared whole, so `MYJSESSIONID` simply is not the key looked
 * up. That is the stronger guard, and mutating it -- not the anchor -- is what
 * turns the decoy test red.
 *
 * The anchor is kept anyway. Under a single non-global `exec` it is now
 * belt-and-braces, because leftmost-match already pins the capture to the
 * header's opening pair; it stops earning its keep the moment someone reaches
 * for `matchAll` to collect every pair, at which point `Path=/` and
 * `Secure=...` would start being read as cookies. Cheap insurance against an
 * edit that looks harmless.
 */
function readCookies(headers: Headers): Map<string, string> {
  const jar = new Map<string, string>();
  for (const cookie of headers.getSetCookie()) {
    const match = /(?:^|;\s*)([^=;\s]+)=([^;]*)/.exec(cookie);
    const name = match?.[1];
    const value = match?.[2];
    if (name && value) jar.set(name, value);
  }
  return jar;
}
