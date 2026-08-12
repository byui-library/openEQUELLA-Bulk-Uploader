import { ApiError } from './errors.js';
import type { AuthProvider } from './auth.js';
import { normaliseInstanceUrl } from './instanceUrl.js';
import { redactSecret } from './redact.js';

/**
 * openEQUELLA's own username/password sign-in.
 *
 * This is the default for institutions that are not behind SSO. It posts to
 * `/api/auth/login` and keeps the returned JSESSIONID, presenting it as a
 * Cookie header so `client.ts` needs no changes: the client merges whatever
 * `authHeader()` returns into every request.
 *
 * SESSION EXPIRY IS NOT HANDLED HERE. A lapsed session produces a 401, and
 * client.ts already responds to a 401 by calling `invalidate()` and retrying
 * once. See the long comment in auth.ts for why expiry is handled reactively
 * rather than on a timer -- the reasoning is identical, and duplicating it
 * with a timer here would put expiry logic in two places.
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

export class UsernamePasswordAuth implements AuthProvider {
  private session: string | null = null;
  private inFlight: Promise<string> | null = null;
  /** Generation the current `inFlight` sign-in was started under. */
  private inFlightGeneration: number | null = null;
  /**
   * Bumped by invalidate(). A completing sign-in only caches its session if
   * the generation it started under is still current, and a caller arriving
   * after invalidate() will not join a sign-in that predates it. Same
   * reasoning as OAuthClientCredentials in auth.ts.
   */
  private generation = 0;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normaliseInstanceUrl(baseUrl);
  }

  async getToken(): Promise<string> {
    if (this.session) return this.session;
    // Collapse concurrent sign-ins into one request -- but only join one that
    // started in the current generation.
    if (!this.inFlight || this.inFlightGeneration !== this.generation) {
      const startedInGeneration = this.generation;
      const promise = this.login(startedInGeneration);
      this.inFlight = promise;
      this.inFlightGeneration = startedInGeneration;
      // Cleanup chain is separate from `promise` itself; callers await
      // `promise` and handle its rejection. Swallow here so `.finally()`'s
      // derived promise does not report the same rejection a second time as
      // an unhandled rejection.
      void promise
        .finally(() => {
          if (this.inFlight === promise) {
            this.inFlight = null;
            this.inFlightGeneration = null;
          }
        })
        .catch(() => {});
    }
    return this.inFlight;
  }

  private async login(startedInGeneration: number): Promise<string> {
    const url = new URL(LOGIN_PATH, this.baseUrl);
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

    const session = readJsessionId(res.headers);
    if (!session) {
      throw new ApiError(
        'Signed in, but the site did not return a session. ' +
          'The address may not be an openEQUELLA site.',
        res.status,
        '',
      );
    }

    // Only cache if nothing invalidated us while this sign-in was in flight.
    if (startedInGeneration === this.generation) {
      this.session = session;
    }
    return session;
  }

  /** Origin + path only — never the query string, which carries the password. */
  private safeEndpoint(): string {
    const url = new URL(LOGIN_PATH, this.baseUrl);
    return `${url.origin}${url.pathname}`;
  }

  private redact(text: string): string {
    return redactSecret(text, this.password);
  }

  async authHeader(): Promise<Record<string, string>> {
    return { Cookie: `JSESSIONID=${await this.getToken()}` };
  }

  invalidate(): void {
    this.session = null;
    this.generation++;
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
    const session = this.session;
    this.invalidate();
    if (!session) return;

    try {
      await this.fetchImpl(new URL(LOGOUT_PATH, this.baseUrl), {
        method: 'PUT',
        headers: { Cookie: `JSESSIONID=${session}` },
      });
    } catch {
      // Deliberately empty -- see the doc comment. A non-2xx response is
      // ignored for the same reason: the body would say nothing this process
      // can act on.
    }
  }
}

/**
 * Pull JSESSIONID out of the response's Set-Cookie headers.
 *
 * `getSetCookie()` and not `get('set-cookie')`: openEQUELLA sets several
 * cookies, and `get()` returns them comma-joined into one string, which both
 * defeats the `(?:^|;\s*)` anchor below and makes an individual cookie
 * impossible to isolate. `getSetCookie()` has existed since Node 19.7 and
 * this module only ever runs in a Node 22 process, so there is nothing to
 * fall back to.
 *
 * The `(?:^|;\s*)` anchor is load-bearing: without it `MYJSESSIONID=nope`
 * matches and the wrong value is returned as the session.
 */
function readJsessionId(headers: Headers): string | null {
  for (const cookie of headers.getSetCookie()) {
    const match = /(?:^|;\s*)JSESSIONID=([^;]+)/.exec(cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}
