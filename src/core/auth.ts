import { ApiError } from './errors.js';
import { instanceEndpoint } from './instanceUrl.js';
import { redactSecret } from './redact.js';
import { SingleFlight } from './singleFlight.js';

export interface AuthProvider {
  getToken(): Promise<string>;
  authHeader(): Promise<Record<string, string>>;
  /** Drop the cached token so the next call re-authenticates. */
  invalidate(): void;
}

/**
 * OAuth 2.0 client-credentials grant.
 *
 * This is the only viable path for unattended runs: the instance sits behind
 * Okta SSO, which cannot be scripted. Items are owned by the user the client
 * is bound to, not by whoever runs the tool.
 *
 * Token lifetime: the token response carries `expires_in`, but this class
 * deliberately does NOT use it to schedule a proactive refresh. A batch run
 * makes bursty, unpredictable request timing (uploads of ~150MB files, one
 * request every few seconds to minutes), so a timer-based refresh would
 * either fire needlessly often or still race a mid-upload expiry. Instead,
 * expiry is handled reactively: Task 7's `client.ts` catches 401s, calls
 * `invalidate()`, and retries once with a freshly minted token. That keeps
 * all expiry-handling logic in one place (the client's retry policy) rather
 * than splitting it between a timer here and a 401 handler there. The cost
 * is that the *first* request after expiry always eats one avoidable 401 —
 * acceptable for a long-running batch tool where that costs a few hundred
 * milliseconds out of a multi-hour run.
 */
/** Shared by the request and by safeEndpoint(), so an error can never name an
 *  endpoint the code did not actually call. */
const TOKEN_PATH = '/oauth/access_token';

export class OAuthClientCredentials implements AuthProvider {
  /**
   * The access token: fetched at most once at a time, dropped by invalidate().
   * Every subtlety -- collapsing concurrent refreshes, refusing to cache a
   * fetch that was invalidated mid-flight, refusing to let a caller arriving
   * after invalidate() join an older fetch -- lives in SingleFlight, shared
   * with UsernamePasswordAuth in passwordAuth.ts.
   */
  private readonly flight = new SingleFlight<string>(() => this.fetchToken());

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  getToken(): Promise<string> {
    return this.flight.get();
  }

  private async fetchToken(): Promise<string> {
    const url = instanceEndpoint(this.baseUrl, TOKEN_PATH);
    url.searchParams.set('grant_type', 'client_credentials');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('client_secret', this.clientSecret);

    let res: Response;
    let body: string;
    try {
      res = await fetch(url, { method: 'POST' });
      body = await res.text();
    } catch {
      // Network-level failure. Never include the request URL here: it
      // carries client_secret in its query string, and some runtimes fold
      // the failing URL into the error message/cause.
      // Deliberately vague about WHERE this failed -- it covers both the
      // fetch and the res.text() that follows it, and the advice is the same
      // either way.
      throw new ApiError(
        `Could not reach ${this.safeEndpoint()}. Check the address and your network connection.`,
        0,
        '',
      );
    }

    if (!res.ok) {
      throw new ApiError(
        this.redact(
          `Token request failed (${res.status}). Check OEQ_CLIENT_ID and OEQ_CLIENT_SECRET credentials.`,
        ),
        res.status,
        this.redact(body),
      );
    }

    let parsed: { access_token?: string };
    try {
      parsed = JSON.parse(body) as { access_token?: string };
    } catch {
      throw new ApiError('Token response was not valid JSON.', res.status, this.redact(body));
    }
    if (!parsed.access_token) {
      throw new ApiError('Token response contained no access_token.', res.status, this.redact(body));
    }

    return parsed.access_token;
  }

  /** Origin + path only — no query string, so it can never carry the secret.
   *  `pathname` (not `origin` alone) is what keeps a hosting prefix here: this
   *  must name the endpoint the code actually called. */
  private safeEndpoint(): string {
    const url = instanceEndpoint(this.baseUrl, TOKEN_PATH);
    return `${url.origin}${url.pathname}`;
  }

  private redact(text: string): string {
    return redactSecret(text, this.clientSecret);
  }

  async authHeader(): Promise<Record<string, string>> {
    return { 'X-Authorization': `access_token=${await this.getToken()}` };
  }

  invalidate(): void {
    this.flight.invalidate();
  }
}
