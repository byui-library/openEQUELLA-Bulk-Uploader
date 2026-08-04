import { BrowserWindow } from 'electron';
import type { AuthorizationCodeAuth } from '../core/authCode.js';
import { OeqError } from '../core/errors.js';

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long to wait, after a navigation load error, for the code-capture
 * listeners to still produce a code before treating the error as fatal. See
 * `resolveSignIn` below for why an error alone is never trusted immediately.
 * A few seconds is generous headroom for the self-inflicted-abort race
 * without meaningfully delaying a genuine failure's error message.
 */
const LOAD_ERROR_GRACE_MS = 3000;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Matches openEQUELLA's own error page heading, e.g. "Problem description: ...". */
const PROBLEM_DESCRIPTION = /Problem description:\s*/i;

/**
 * Pulls openEQUELLA's own error text out of a rendered error page, when
 * present.
 *
 * LIVE BUG, reported by an operator: a failed sign-in surfaced
 * "Sign-in could not load openEQUELLA: ERR_FAILED (-2) loading
 * '.../oauth/authorise?...'" -- a transport error naming a URL, not a
 * reason. The page openEQUELLA actually rendered said exactly what was
 * wrong: "No OAuth client can be found with the supplied client_id (...) and
 * redirect_uri (...)" under a "Problem description:" heading. Reporting the
 * transport error when the server sent a perfectly good explanation is
 * unhelpful, so `signInInteractive` reads the page's visible text and
 * prefers this over the load error whenever it finds something.
 *
 * Deliberately a pure string -> string|null function, independent of any
 * BrowserWindow, so it's unit-testable without booting Electron -- see
 * `betterSignInError` below for how it's wired to the live page text.
 */
export function extractOeqError(pageText: string): string | null {
  const match = PROBLEM_DESCRIPTION.exec(pageText);
  if (!match) return null;
  const rest = pageText.slice(match.index + match[0].length);
  // The description runs until the next blank line (a run of two or more
  // newlines) or the end of the text, whichever comes first -- openEQUELLA's
  // error page has further boilerplate (a "Return to application" link,
  // etc.) below it that must not be swept in.
  const blankLine = /\n\s*\n/.exec(rest);
  const raw = (blankLine ? rest.slice(0, blankLine.index) : rest).replace(/\s+/g, ' ').trim();
  return raw === '' ? null : raw;
}

/**
 * Upgrades a sign-in failure to openEQUELLA's own error text, when the
 * window is still showing a page that has one. Best-effort and strictly
 * defensive: `executeJavaScript` can reject if the window has already been
 * destroyed (a real race with the `finally` block in `signInInteractive`
 * below), and the window may have navigated somewhere else, or nowhere at
 * all, by the time this runs. Any failure along this path falls back to the
 * original error -- reading the page must never itself become a new way for
 * sign-in to fail.
 *
 * Scoped to the instance's own ORIGIN, matching the load-bearing capture
 * rule elsewhere in this file: a page from anywhere else (an SSO provider
 * mid-redirect, about:blank, ...) is never inspected.
 */
async function betterSignInError(win: BrowserWindow, origin: string, fallback: Error): Promise<Error> {
  if (win.isDestroyed()) return fallback;
  let currentUrl: URL;
  try {
    currentUrl = new URL(win.webContents.getURL());
  } catch {
    return fallback;
  }
  if (currentUrl.origin !== origin) return fallback;

  let text: unknown;
  try {
    text = await win.webContents.executeJavaScript(
      'document.body ? document.body.innerText : ""',
    );
  } catch {
    return fallback;
  }
  const found = extractOeqError(typeof text === 'string' ? text : '');
  return found ? new OeqError(found) : fallback;
}

export interface SignInRace {
  /** Resolves once a code has been captured. Never rejects. */
  code: Promise<string>;
  /**
   * Resolves with the first load error observed on either `loadURL` call.
   * Never rejects itself -- the error is a resolved VALUE here, not a
   * rejection, precisely so it can sit in a `Promise.race` alongside `code`
   * without either one starving the other.
   */
  loadError: Promise<Error>;
  /** Grace period, in ms, given to `code` after a load error before giving up. */
  graceMs: number;
  /** Injected so tests can control timing without real delays. */
  delay: (ms: number) => Promise<void>;
}

/**
 * Decides whether a load error observed during sign-in is a real failure.
 *
 * LIVE BUG, reported by an operator: `loadURL(authorizeUrl)` (and, less
 * often, `loadURL(baseUrl)`) is a navigation THIS MODULE may abort out from
 * under itself. As soon as `inspect()` (in `signInInteractive` below)
 * captures the code, the window gets destroyed while that navigation may
 * still be in flight, and Electron surfaces the abort as `ERR_FAILED (-2)`
 * -- "this navigation was aborted," not "the network failed." Treating that
 * as fatal turns a routine self-inflicted abort -- direct evidence sign-in
 * WORKED -- into a false failure.
 *
 * This shipped without the grace period once already and passed manual
 * verification anyway: on a FIRST sign-in, openEQUELLA shows an Authorize
 * button, a human-speed pause that always let the capture win the race.
 * Once the operator has granted the client, a SECOND sign-in redirects
 * immediately, and the abort can land before the capture listener fires.
 * That is exactly the race this function exists to lose gracefully: a load
 * error is never trusted the instant it arrives, only after a short grace
 * period has passed with no code showing up. If a code does arrive within
 * that window, the error is discarded entirely, not merely deprioritised.
 */
export async function resolveSignIn(race: SignInRace): Promise<string> {
  const first = await Promise.race([
    race.code.then((code) => ({ kind: 'code' as const, code })),
    race.loadError.then((error) => ({ kind: 'error' as const, error })),
  ]);
  if (first.kind === 'code') return first.code;

  const graced = await Promise.race([
    race.code.then((code) => ({ kind: 'code' as const, code })),
    race.delay(race.graceMs).then(() => ({ kind: 'timeout' as const })),
  ]);
  if (graced.kind === 'code') return graced.code;

  throw new OeqError(`Sign-in could not load openEQUELLA: ${first.error.message}`);
}

/**
 * Opens openEQUELLA in a window and captures the OAuth code from its own
 * navigation events.
 *
 * Three behaviours here are load-bearing and were learned from live runs,
 * unreachable from any mock:
 *
 *  1. The session is established FIRST. Navigating straight to
 *     /oauth/authorise while logged out bounces through Okta, which returns
 *     the browser to a bare /oauth/authorise with the query string stripped;
 *     openEQUELLA then reports "client_id (null)".
 *  2. `redirect_uri` is never re-derived or normalised here -- it comes
 *     verbatim from `auth.getAuthorizeUrl()` (session.ts/authCode.ts already
 *     own that).
 *  3. Capture matches on the instance's own ORIGIN. Signing in via SSO also
 *     produces a ?code= on id.churchofjesuschrist.org, and exchanging that
 *     one fails obscurely.
 *
 * A fourth thing is load-bearing but isn't about *what* URL to load: neither
 * `loadURL` call below is trusted to fail fast -- see `resolveSignIn`.
 */
export async function signInInteractive(
  baseUrl: string,
  auth: AuthorizationCodeAuth,
  parent?: BrowserWindow,
): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const win = new BrowserWindow({
    width: 900,
    height: 800,
    parent,
    modal: Boolean(parent),
    title: 'Sign in to openEQUELLA',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  let armed = false;
  let codeCaptured = false;
  // Flipped once the outer race below has settled, so the background
  // navigation loop (which isn't awaited -- see the fire-and-forget IIFE)
  // stops promptly instead of continuing to poll a window that's about to
  // be destroyed for up to the full SIGN_IN_TIMEOUT_MS.
  let stopped = false;

  let resolveCode!: (code: string) => void;
  const codePromise = new Promise<string>((resolve) => {
    resolveCode = (code) => {
      if (codeCaptured) return;
      codeCaptured = true;
      resolve(code);
    };
  });

  let loadErrorSeen = false;
  let resolveLoadError!: (err: Error) => void;
  const loadErrorPromise = new Promise<Error>((resolve) => {
    resolveLoadError = (err) => {
      if (loadErrorSeen) return; // only the first load error is meaningful
      loadErrorSeen = true;
      resolve(err);
    };
  });

  const inspect = (url: string): void => {
    if (!armed || codeCaptured) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.origin !== origin) return;
    if (parsed.pathname.startsWith('/oauth/authorise')) return;
    const found = parsed.searchParams.get('code');
    if (found) resolveCode(found);
  };

  win.webContents.on('will-redirect', (_e, url) => inspect(url));
  win.webContents.on('did-navigate', (_e, url) => inspect(url));
  win.webContents.on('will-navigate', (_e, url) => inspect(url));

  const closedPromise = new Promise<never>((_resolve, reject) => {
    win.on('closed', () => {
      if (!codeCaptured) reject(new OeqError('Sign-in window was closed before completing.'));
    });
  });

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new OeqError('Sign-in timed out.')), SIGN_IN_TIMEOUT_MS);
  });

  // Fire-and-forget: this drives the two loadURL calls, but its outcome is
  // deliberately NOT what decides success or failure for signInInteractive
  // -- that's resolveSignIn's job, fed by codePromise/loadErrorPromise
  // below. Any rejection here is swallowed (there is nowhere useful for it
  // to go once both of those have their own path to the decision), so it
  // can never surface as an unhandled rejection.
  void (async () => {
    // Step 1: establish the session. A load error here is recorded, not
    // thrown -- see resolveSignIn.
    await win.loadURL(baseUrl).catch((err: unknown) => resolveLoadError(toError(err)));

    while (!codeCaptured && !stopped) {
      const isUser = await win.webContents
        .executeJavaScript(
          `fetch('/api/content/currentuser',{credentials:'include'})
             .then(r => r.ok ? r.json() : null)
             .then(u => !!u && u.guest === false)
             .catch(() => false)`,
        )
        .catch(() => false);
      if (isUser) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (codeCaptured || stopped) return;

    // Step 2: only now does the authorize URL keep its query string. This
    // navigation is DESIGNED to be interrupted -- see resolveSignIn.
    armed = true;
    await win.loadURL(auth.getAuthorizeUrl()).catch((err: unknown) => resolveLoadError(toError(err)));
  })().catch(() => {});

  let code: string;
  try {
    code = await Promise.race([
      resolveSignIn({
        code: codePromise,
        loadError: loadErrorPromise,
        graceMs: LOAD_ERROR_GRACE_MS,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      }).catch(async (err: unknown) => {
        // Before reporting a load error, give openEQUELLA's own error page a
        // chance to explain itself -- see betterSignInError's doc comment.
        // Scoped to resolveSignIn's own rejection only: closedPromise and
        // timeoutPromise are different failure modes (the window is gone, or
        // nothing happened for ten minutes) that this page-read doesn't
        // apply to.
        throw await betterSignInError(win, origin, toError(err));
      }),
      closedPromise,
      timeoutPromise,
    ]);
  } finally {
    stopped = true;
    if (!win.isDestroyed()) win.destroy();
  }

  await auth.exchangeCode(code);
}
