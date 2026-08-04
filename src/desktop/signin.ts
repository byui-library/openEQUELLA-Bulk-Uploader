import { BrowserWindow } from 'electron';
import type { AuthorizationCodeAuth } from '../core/authCode.js';
import { OeqError } from '../core/errors.js';

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

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

  const code = await new Promise<string>((resolve, reject) => {
    let armed = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new OeqError('Sign-in timed out.'));
      }
    }, SIGN_IN_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const inspect = (url: string): void => {
      if (!armed) return;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.origin !== origin) return;
      if (parsed.pathname.startsWith('/oauth/authorise')) return;
      const found = parsed.searchParams.get('code');
      if (found) finish(() => resolve(found));
    };

    win.webContents.on('will-redirect', (_e, url) => inspect(url));
    win.webContents.on('did-navigate', (_e, url) => inspect(url));
    win.webContents.on('will-navigate', (_e, url) => inspect(url));

    win.on('closed', () => finish(() => reject(new OeqError('Sign-in window was closed before completing.'))));

    void (async () => {
      // Step 1: establish the session.
      await win.loadURL(baseUrl);

      const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
      while (Date.now() < deadline && !settled) {
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
      if (settled) return;

      // Step 2: only now does the authorize URL keep its query string.
      armed = true;
      await win.loadURL(auth.getAuthorizeUrl());
    })().catch((err: unknown) => finish(() => reject(err)));
  }).finally(() => {
    if (!win.isDestroyed()) win.destroy();
  });

  await auth.exchangeCode(code);
}
