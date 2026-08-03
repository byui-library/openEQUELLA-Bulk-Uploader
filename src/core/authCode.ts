import { OeqError, ApiError } from './errors.js';
import type { AuthProvider } from './auth.js';
import { FileTokenStore, type TokenStore } from './tokenStore.js';

/**
 * OAuth 2.0 authorization-code grant.
 *
 * This instance's OAuth client is deliberately NOT registered with a fixed
 * user (see `docs/SESSION-HANDOFF.md`), so client-credentials
 * (`OAuthClientCredentials` in `auth.ts`) is rejected outright with
 * `invalid_client`. Each contributor authenticates as themselves instead,
 * through the normal Okta SSO screen, and items are owned by whoever ran the
 * login flow -- not by a shared service account.
 *
 * Flow (verified against `content-test.byui.edu`):
 *   1. `getAuthorizeUrl()` -- the operator opens this in a browser and signs
 *      in via SSO.
 *   2. openEQUELLA redirects to the registered `redirectUrl`, which on this
 *      instance is the **site root**, not a loopback callback -- so this
 *      tool cannot capture the code on a local listener. The code arrives as
 *      `?code=...` on the resulting page and the operator copies it in.
 *   3. `exchangeCode(code)` -- POSTs the code for a token and caches it, both
 *      in memory and (so a detached child process can pick it up) via the
 *      injected `TokenStore`.
 *
 * `redirect_uri` MUST be byte-identical between steps 1 and 3 -- openEQUELLA
 * validates the two match, and per the design doc this is the single most
 * common way this flow breaks in practice. Both steps read the same
 * `this.redirectUri`, normalised exactly once in the constructor, so they
 * can never drift apart. The server also strips a trailing slash from
 * whatever `redirect_uri` it receives, so an un-normalised value here would
 * fail that comparison even when it's "the same" URL to a human.
 *
 * Unlike `OAuthClientCredentials`, this provider cannot refresh itself: there
 * is no way to mint a new token without a human back at a browser. A 401 mid
 * run therefore cannot be recovered from unattended -- see invalidate()'s
 * comment and the design doc's "Consequences" section.
 */
export class AuthorizationCodeAuth implements AuthProvider {
  private token: string | null = null;
  private readonly baseUrl: string;
  private readonly redirectUri: string;
  private readonly tokenStore: TokenStore;

  constructor(
    baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    redirectUri: string,
    tokenStore: TokenStore = new FileTokenStore(),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.redirectUri = redirectUri.replace(/\/+$/, '');
    this.tokenStore = tokenStore;
  }

  /** The URL the operator opens in a browser to authenticate via SSO. */
  getAuthorizeUrl(): string {
    const url = new URL('/oauth/authorise', this.baseUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    return url.toString();
  }

  /**
   * Exchange a one-time authorization code for an access token, and cache
   * it (in memory, and persisted via the token store so a detached process
   * can use it too).
   */
  async exchangeCode(code: string): Promise<void> {
    const url = new URL('/oauth/access_token', this.baseUrl);
    url.searchParams.set('grant_type', 'authorization_code');
    url.searchParams.set('code', code);
    url.searchParams.set('redirect_uri', this.redirectUri);
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
      throw new ApiError(
        `Authorization code exchange request to ${this.safeEndpoint()} failed before a response was received.`,
        0,
        '',
      );
    }

    if (!res.ok) {
      throw new ApiError(
        this.redact(
          `Authorization code exchange failed (${res.status}). This is usually either an ` +
            `expired or already-used code, or a redirect_uri mismatch -- check that ` +
            `OEQ_REDIRECT_URI matches exactly what is registered on the OAuth client ` +
            `(no trailing slash).`,
        ),
        res.status,
        this.redact(body),
      );
    }

    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(body) as { access_token?: string; expires_in?: number };
    } catch {
      throw new ApiError('Token response was not valid JSON.', res.status, this.redact(body));
    }
    if (!parsed.access_token) {
      throw new ApiError('Token response contained no access_token.', res.status, this.redact(body));
    }

    this.token = parsed.access_token;
    const expiresAt =
      typeof parsed.expires_in === 'number' ? Date.now() + parsed.expires_in * 1000 : undefined;
    await this.tokenStore.save({
      accessToken: parsed.access_token,
      baseUrl: this.baseUrl,
      expiresAt,
    });
  }

  /**
   * Returns the cached token -- from memory if `exchangeCode()` was just
   * called in this process, or from the token store if a prior (typically
   * interactive) process already logged in and this is e.g. the detached
   * runner picking it up.
   *
   * Deliberately never prompts and never makes a network call: this
   * provider may be running headless/detached, with no terminal or browser
   * attached to prompt through. If there is nothing usable, it throws an
   * actionable `OeqError` telling the operator to run the login flow
   * (`getAuthorizeUrl()` + `exchangeCode()`) themselves, first.
   */
  async getToken(): Promise<string> {
    if (this.token) return this.token;

    const stored = await this.tokenStore.load(this.baseUrl);
    if (stored) {
      this.token = stored;
      return stored;
    }

    // No usable token. Look at the raw record (if any) purely to explain
    // *why* in the error -- this doesn't change the outcome, which is
    // always "go run the login flow again."
    //
    // The message below names the actual CLI command (`oeq-upload login`),
    // not the internal API (`getAuthorizeUrl()`/`exchangeCode()`) an earlier
    // version of this message pointed at -- this is the message an operator
    // reads in `check`/`oeq_check` output or a failed `run`, and neither of
    // those method names mean anything to them or is something they can act
    // on directly. Action first, explanation second (and only if it stays
    // short) -- see the coordinator note that prompted this rewrite.
    const raw = await this.tokenStore.loadRaw();
    const runLogin = 'Run:  oeq-upload login';

    if (raw && raw.baseUrl !== this.baseUrl) {
      throw new OeqError(
        `Cached OAuth token was issued for ${raw.baseUrl}, not ${this.baseUrl} -- refusing to ` +
          `reuse it across instances.\n${runLogin}`,
      );
    }
    if (raw && raw.expiresAt !== undefined && raw.expiresAt <= Date.now()) {
      throw new OeqError(
        `Cached OAuth token for ${this.baseUrl} expired at ` +
          `${new Date(raw.expiresAt).toISOString()}.\n${runLogin}`,
      );
    }
    throw new OeqError(`No cached OAuth token for ${this.baseUrl}.\n${runLogin}`);
  }

  async authHeader(): Promise<Record<string, string>> {
    return { 'X-Authorization': `access_token=${await this.getToken()}` };
  }

  /**
   * Drops the in-memory token AND the persisted one -- unlike
   * `OAuthClientCredentials.invalidate()`, this cannot trigger a fresh
   * fetch (there is no way to mint a new token without operator
   * interaction), so "next call re-authenticates" can only mean "next call
   * fails fast and says so."
   *
   * This matters at batch scale: without clearing the store, a 401 on row 1
   * would invalidate only the in-memory copy, `client.ts`'s single retry
   * would re-read the *same* token from disk and fail again, and then every
   * subsequent row (2..37) would independently repeat that same
   * fetch-stale-token-then-401 dance -- dozens of confusing
   * `POST /api/item failed (401)` errors when the real problem is just "the
   * session ended." Clearing the store here means row 1 still fails once
   * (nothing can prevent that -- the 401 is what revealed the token was
   * bad), but every row after it gets the same fast, actionable "no cached
   * token, log in again" error from `getToken()` instead of repeating the
   * same doomed round-trip.
   *
   * Uses `clearSync()`, not `clear()`: `AuthProvider.invalidate()` (auth.ts)
   * returns `void`, and `client.ts` calls it without awaiting, then
   * immediately retries in the same tick -- see `clearSync()`'s doc in
   * tokenStore.ts for why an unawaited async delete would race that retry.
   */
  invalidate(): void {
    this.token = null;
    this.tokenStore.clearSync();
  }

  /** Origin + path only -- no query string, so it can never carry the secret. */
  private safeEndpoint(): string {
    const url = new URL('/oauth/access_token', this.baseUrl);
    return `${url.origin}${url.pathname}`;
  }

  private redact(text: string): string {
    if (!this.clientSecret) return text;
    // The secret travels in a query string, so on the wire (and in anything
    // that echoes the raw request back, e.g. an error body) it appears
    // percent-encoded, not literal. Base64-alphabet secrets -- the
    // overwhelming common case for generated OAuth secrets -- contain '+',
    // '/', '=', all of which get percent-escaped, so both forms must be
    // redacted.
    let result = text.split(this.clientSecret).join('[REDACTED]');
    const encoded = encodeURIComponent(this.clientSecret);
    if (encoded !== this.clientSecret) {
      result = result.split(encoded).join('[REDACTED]');
    }
    return result;
  }
}
