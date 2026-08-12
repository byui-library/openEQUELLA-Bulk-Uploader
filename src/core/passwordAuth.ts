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
    const url = new URL('/api/auth/login', this.baseUrl);
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
      throw new ApiError(
        `Sign-in request to ${this.safeEndpoint()} failed before a response was received.`,
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
        'Sign-in returned success but no session cookie, so nothing is authenticated. ' +
          'The address may point at something that is not openEQUELLA.',
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
    const url = new URL('/api/auth/login', this.baseUrl);
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
}

/** Pull JSESSIONID out of the response's Set-Cookie headers. */
function readJsessionId(headers: Headers): string | null {
  const all =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];
  for (const cookie of all) {
    const match = /(?:^|;\s*)JSESSIONID=([^;]+)/.exec(cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}
