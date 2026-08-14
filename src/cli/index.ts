#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { createServer as createHttpServer } from 'node:http';
import { loadConfig, createAuthProvider } from '../core/config.js';
import { readSheet } from '../core/sheet.js';
import { extractDefinition, extractItemNamePath, parseSchemaPaths } from '../core/schema.js';
import { buildManifest, preflightDuplicates, markSkipped } from '../core/plan.js';
import { findDuplicates, defaultChoice } from '../core/duplicates.js';
import { saveManifest, loadManifest } from '../core/state.js';
import { AuthorizationCodeAuth } from '../core/authCode.js';
import { FileTokenStore, type TokenStore } from '../core/tokenStore.js';
import type { LogoutOutcome } from '../core/passwordAuth.js';
import { OeqClient } from '../core/client.js';
import { assertNotGuest } from '../core/identity.js';
import { runManifest } from '../core/runner.js';
import { runPreflight, summarise } from '../core/preflight.js';
import { checkLock } from '../core/lock.js';
import { OeqError, ValidationError } from '../core/errors.js';
import type { ItemState } from '../core/types.js';
import { runExtract, type ExtractCliOptions } from './extract.js';

type Env = Record<string, string | undefined>;

/**
 * `--state` arrives from Commander as an unchecked string. `buildManifest`
 * takes a typed `ItemState`, but TypeScript can't validate a CLI argument --
 * a typo like `--state Published` would otherwise sail through and publish
 * every item live, in a collection with no moderation workflow to catch it.
 * Validated eagerly, before any I/O, so a bad value fails fast rather than
 * after the sheet/schema have already been read.
 */
function parseItemState(state: string): ItemState {
  if (state !== 'draft' && state !== 'published') {
    throw new ValidationError(
      `--state must be 'draft' or 'published', got '${state}'. Refusing to guess -- this ` +
        `collection has no moderation workflow, so a wrong value here would publish live.`,
    );
  }
  return state;
}

export interface PlanCliOptions {
  sheet: string;
  files: string;
  manifest: string;
  schemaFile: string;
  state: string;
  skipDuplicateCheck?: boolean;
  uploadDuplicates?: boolean;
}

export async function planAction(o: PlanCliOptions, env: Env = process.env): Promise<void> {
  const itemState = parseItemState(o.state);
  const cfg = loadConfig(env);

  const sheet = await readSheet(resolve(o.sheet));
  const schemaXml = await readFile(o.schemaFile, 'utf8');
  const paths = parseSchemaPaths(extractDefinition(schemaXml));
  // Which field holds the title is read from the same schema export the paths
  // come from, never assumed: it is `MWDL/title` at BYU-Idaho and something
  // else at every other institution, and the duplicate check searches on it.
  const titleHeader = extractItemNamePath(schemaXml);
  const manifest = await buildManifest(sheet, resolve(o.files), paths, {
    baseUrl: cfg.baseUrl,
    collectionUuid: cfg.collectionUuid,
    schemaUuid: cfg.schemaUuid,
    itemState,
    attachmentUuidPath: cfg.attachmentUuidPath,
  });

  if (!o.skipDuplicateCheck) {
    const client = new OeqClient(cfg.baseUrl, createAuthProvider(cfg, env));
    // The schema, not a literal: which field holds the identifier is resolved
    // from these paths (see resolveIdentifierPath), and a hardcoded
    // `MWDL/identifier` checked nothing at all anywhere else.
    const dupWarnings = await preflightDuplicates(client, manifest, { titleHeader, paths });
    manifest.warnings.push(...dupWarnings);

    const findings = await findDuplicates(client, manifest, titleHeader);
    for (const f of findings) {
      console.log(`  Row ${f.rowNumber}: ${f.fileName} -- ${f.tier}: ${f.detail}`);
    }

    // markSkipped MUST run before saveManifest below, or the skip never
    // reaches disk and `run` uploads the row anyway. Only 'near-certain'
    // defaults to skip -- see defaultChoice's own doc for why a title-only
    // match uploads instead: a duplicate can be seen and deleted, an item
    // that silently never arrived cannot be noticed.
    if (!o.uploadDuplicates) {
      const toSkip = findings.filter((f) => defaultChoice(f.tier) === 'skip').map((f) => f.rowNumber);
      const skipped = markSkipped(manifest, toSkip, 'skipped as a duplicate of an existing item');
      if (skipped > 0) {
        console.log(
          `Skipped ${skipped} row(s) that look like duplicates of an existing item. Re-run ` +
            `with --upload-duplicates to upload them anyway.`,
        );
      }
    }
  }

  await saveManifest(o.manifest, manifest);
  console.log(`Planned ${manifest.entries.length} item(s) -> ${o.manifest}`);
  for (const w of manifest.warnings) console.log(`  warning: ${w}`);
}

export interface RunCliOptions {
  manifest: string;
  forceInterrupted?: boolean;
  maxAttempts?: number;
}

/**
 * Returns the process exit code the caller should use: 1 if any row
 * genuinely failed, 0 otherwise.
 *
 * `interrupted` alone does NOT produce exit code 1. A row lands there only
 * because a *previous* run died mid-upload -- this run made no mistake and
 * attempted nothing risky for it, it deliberately declined to guess. Exiting
 * 1 would make "an ambiguous leftover from last time, go check by hand" look
 * identical, in any script or CI job watching the exit code, to "this run
 * itself hit real errors" (`failed`), which needs different handling
 * (usually: fix something and retry). The prominent console message below
 * carries the actual signal; the exit code stays reserved for "this
 * invocation did something wrong."
 */
export async function runAction(o: RunCliOptions, env: Env = process.env): Promise<number> {
  const cfg = loadConfig(env);
  const client = new OeqClient(cfg.baseUrl, createAuthProvider(cfg, env));
  const summary = await runManifest(client, o.manifest, {
    forceInterrupted: o.forceInterrupted,
    maxAttempts: o.maxAttempts,
    onProgress: (e, done, total) =>
      console.log(`[${done}/${total}] ${e.fileName} -> ${e.status}${e.error ? `: ${e.error}` : ''}`),
  });

  console.log(
    `created=${summary.created} failed=${summary.failed} skipped=${summary.skipped} ` +
      `incomplete=${summary.incomplete} interrupted=${summary.interrupted}`,
  );

  if (summary.interrupted > 0) {
    console.log(
      `\n${summary.interrupted} row(s) were left untouched because a previous run was ` +
        `interrupted mid-upload for them; the item may or may not already exist in ` +
        `openEQUELLA. Check the collection by hand, then re-run with --force-interrupted ` +
        `to process those rows once you've confirmed it's safe.`,
    );
  }

  return summary.failed > 0 ? 1 : 0;
}

export interface StatusCliOptions {
  manifest: string;
}

export async function statusAction(o: StatusCliOptions): Promise<void> {
  const m = await loadManifest(o.manifest);

  const counts: Record<string, number> = {};
  for (const e of m.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  console.log(JSON.stringify(counts, null, 2));

  const failed = m.entries.filter((e) => e.status === 'failed');
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const e of failed) console.log(`  row ${e.rowNumber} ${e.fileName}: ${e.error ?? 'unknown error'}`);
  }

  const interrupted = m.entries.filter((e) => e.status === 'uploading');
  if (interrupted.length > 0) {
    console.log('\nInterrupted (a prior run died mid-upload; verify in openEQUELLA before retrying):');
    for (const e of interrupted)
      console.log(`  row ${e.rowNumber} ${e.fileName}: ${e.error ?? 'interrupted'}`);
  }

  const lock = await checkLock(o.manifest);
  if (lock) {
    console.log(`\nLock held by pid ${lock.pid} (started ${lock.startedAt}); a run may be in progress.`);
  } else {
    console.log('\nNo active lock.');
  }
}

export interface RetryCliOptions {
  manifest: string;
}

/**
 * Resets `failed` entries only -- `pending` and `attempts: 0` -- so
 * `runManifest` gives them a fresh attempt budget on the next `run`.
 *
 * Deliberately does NOT touch entries left `'uploading'` (interrupted-at-load,
 * see runner.ts). Those are ambiguous: the item may already have been
 * created server-side, and only a human who has actually checked the
 * collection can know it's safe to reprocess. `run --force-interrupted` is
 * that explicit, one-time acknowledgement, made at the moment of the run
 * that will act on it. Folding the same reset into `retry` would let a
 * routine "clear my failures and go again" habit silently reprocess a
 * row that might already have a real item behind it -- turning a cheap,
 * reversible mistake (re-running a `failed` row, which never created
 * anything) into an expensive, hard-to-undo one (a duplicate ~150 MB
 * contribution).
 */
export async function retryAction(o: RetryCliOptions): Promise<void> {
  const lock = await checkLock(o.manifest);
  if (lock) {
    throw new OeqError(
      `Manifest ${o.manifest} is locked by process ${lock.pid}` +
        (lock.startedAt ? ` (started ${lock.startedAt})` : '') +
        `. A run may still be in progress; retrying now would overwrite its progress with a ` +
        `stale snapshot and risk a duplicate upload. Wait for it to finish, or confirm the ` +
        `process is really gone before deleting ${o.manifest}.lock by hand.`,
    );
  }

  const m = await loadManifest(o.manifest);
  let reset = 0;
  for (const e of m.entries) {
    if (e.status === 'failed') {
      e.status = 'pending';
      e.attempts = 0;
      delete e.error;
      reset++;
    }
  }
  await saveManifest(o.manifest, m);
  console.log(`Reset ${reset} failed entr${reset === 1 ? 'y' : 'ies'} to pending. Run \`oeq-upload run\` to continue.`);
}

// ---------------------------------------------------------------------------
// login / logout / check -- the authorization-code flow (see
// docs/SESSION-HANDOFF.md and src/core/authCode.ts). Everything network- or
// prompt-related is injectable via `deps` so tests never spawn a real
// browser or block on real stdin -- see tests/cli.test.ts.
// ---------------------------------------------------------------------------

/** `start`/`open`/`xdg-open` as appropriate, best-effort. Never throws --
 *  headless/SSH use must still work, with the URL printed either way. */
/**
 * How to open a URL in the operator's browser, per platform.
 *
 * Windows does NOT go through `cmd /c start`. It used to, and cmd.exe treats
 * `&` as a command separator -- so the authorize URL, which carries
 * `&client_id=` and `&redirect_uri=`, was cut at the first one. Only
 * `?response_type=code` reached the browser, and openEQUELLA answered
 * "No OAuth client can be found with the supplied client_id (null) and
 * redirect_uri (null)". The login command's own instructions blamed a cold SSO
 * session for that message; the real cause was here, and no amount of signing
 * in first would have helped.
 *
 * `rundll32 url.dll,FileProtocolHandler` is a plain executable, so the URL is
 * passed as one argument with no shell parsing it at all.
 *
 * Exported for tests: the bug was invisible except by reading the argv.
 */
export function browserCommand(platform: string, url: string): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

function defaultOpenBrowser(url: string): void {
  const { command, args } = browserCommand(process.platform, url);
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

async function defaultPromptForCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question('Paste the code, or the full URL containing it, here: ');
  } finally {
    rl.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pulls a `code` value out of whatever the operator pasted at the manual
 * prompt (see the "Manual path" doc on `loginAction` below). Accepts three
 * shapes, tried in order:
 *
 *   1. A full URL (the expected case -- see loginAction's doc for why the
 *      operator is told to paste a browser-HISTORY entry, which is a whole
 *      URL, not a bare code): parsed and its `code` search param returned.
 *   2. A bare query string, e.g. `?code=abcd1234&state=...` or
 *      `code=abcd1234` -- not a valid absolute URL on its own, so (1) fails
 *      to parse, but the same param is still extractable with a regex.
 *   3. Anything else is assumed to already BE the bare code, unchanged
 *      (this is what makes the manual prompt keep working exactly as before
 *      for an operator who already isolated the code themselves).
 *
 * Exported (not just used internally) so it can be unit tested directly
 * against all three shapes without driving the whole `loginAction` flow.
 */
export function extractCode(input: string): string {
  const trimmed = input.trim();
  try {
    const asUrl = new URL(trimmed);
    const fromUrl = asUrl.searchParams.get('code');
    if (fromUrl) return fromUrl;
  } catch {
    // Not an absolute URL -- fall through to the query-string/bare-code cases.
  }
  const match = /(?:^|[?&])code=([^&\s]+)/.exec(trimmed);
  if (match) return decodeURIComponent(match[1]!);
  return trimmed;
}

/** Minimal escaping for the one place `defaultCaptureLoopbackCode` reflects
 *  server-controlled text (the OAuth `error` param) into a locally-served
 *  HTML page. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The redirect URI's host/port/path, if (and only if) it names a loopback
 * address -- the signal `loginAction` uses to choose loopback capture over
 * the manual-paste fallback. Returns null for anything else (a real host --
 * this instance's site-root registration, in particular).
 */
function loopbackTarget(redirectUri: string): { hostname: string; port: number; pathname: string } | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '::1') return null;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { hostname: url.hostname, port, pathname: url.pathname };
}

/**
 * Starts a one-shot `node:http` server on `redirectUri`'s own host/port and
 * resolves with the `code` query parameter from the first request that
 * carries one (or an `error` param) -- i.e. the browser's redirect after the
 * operator signs in and authorizes. Requests that carry neither (favicon
 * fetches, a stray probe, etc.) get a 404 and the server keeps waiting.
 *
 * This is the standard native-app OAuth loopback pattern: nothing is typed
 * or pasted, because the code never has to survive in an address bar or
 * history entry at all -- it arrives as a normal HTTP request this process
 * is already listening for.
 */
function defaultCaptureLoopbackCode(redirectUri: string): Promise<string> {
  const target = new URL(redirectUri);
  return new Promise((resolvePromise, reject) => {
    const server = createHttpServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? target.host}`);
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');
      if (!code && !error) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found.');
        return;
      }
      // `Connection: close` so the browser doesn't hold a keep-alive socket
      // open -- without it, `server.close()` below (which waits for
      // in-flight connections to finish on their own) can stall for however
      // long the client's keep-alive timeout is, needlessly delaying a
      // login that has, in substance, already succeeded.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(
        error
          ? `<html><body><h1>Sign-in failed</h1><p>openEQUELLA reported: ${escapeHtml(error)}</p>` +
              `<p>You can close this tab and check the terminal.</p></body></html>`
          : `<html><body><h1>Signed in</h1><p>You can close this tab and return to the terminal -- ` +
              `oeq-upload has what it needs.</p></body></html>`,
      );
      server.close(() => {
        if (error) reject(new OeqError(`openEQUELLA returned an error during sign-in: ${error}`));
        else resolvePromise(code!);
      });
    });
    server.on('error', reject);
    server.listen(target.port ? Number(target.port) : 80, target.hostname);
  });
}

/**
 * `login` REFUSES in password mode rather than quietly succeeding.
 *
 * There is nothing for it to do: no browser flow, no cached token, and the
 * credentials are read from the environment on every run. Exiting 0 would be
 * the worse option -- `oeq-upload login` reporting success while verifying
 * nothing is precisely the kind of confidently-wrong signal this project has
 * already been bitten by, and a script chaining `login && run` would take it
 * as "credentials confirmed". `check` is the command that actually confirms
 * them, so the message points there.
 */
const PASSWORD_MODE_NO_LOGIN =
  'Sign-in is not needed in password mode -- your username and password are read from ' +
  'OEQ_USERNAME and OEQ_PASSWORD on every run, so there is no browser flow and no token to ' +
  'cache. Run `oeq-upload check` to confirm they work.';

export interface LoginDeps {
  tokenStore?: TokenStore;
  openBrowser?: (url: string) => void;
  promptForCode?: () => Promise<string>;
  /** Overridable for tests; see `defaultCaptureLoopbackCode` for the real implementation. */
  captureLoopbackCode?: (redirectUri: string) => Promise<string>;
}

/**
 * Authenticate via the authorization-code flow and cache a token that `run`
 * (and a detached `oeq_start_job` runner) can pick up. Never fails just
 * because the browser couldn't be opened -- the URL is always printed too.
 *
 * Two ways the code gets from the browser back to this process, chosen
 * automatically from `OEQ_REDIRECT_URI` (never guessed from cookies -- this
 * process has no access to the browser's session):
 *
 *   - Loopback capture (preferred): if the redirect URI points at
 *     `localhost`/`127.0.0.1`, a temporary local server catches the
 *     redirect and pulls `code` off it directly -- nothing to paste. This is
 *     the standard native-app OAuth pattern; see the README for how to
 *     register a client that enables it.
 *   - Manual paste (the fallback, and the only option against THIS
 *     instance's current client, whose `redirectUrl` is the site root, not
 *     a loopback address): openEQUELLA's home page discards the `?code=`
 *     query string within about a second of loading, so copying it straight
 *     out of the address bar is a race the operator will usually lose. The
 *     reliable way is the browser's HISTORY, which still has the
 *     intermediate `?code=...` entry even after the address bar has moved
 *     on -- see the printed instructions below.
 *
 * Also prints a warning, unconditionally, before opening anything: a COLD
 * SSO session (no prior openEQUELLA session in this browser) makes the
 * first `/oauth/authorise` visit bounce through Okta and land back on a
 * BARE `/oauth/authorise` -- openEQUELLA drops the query string on that
 * bounce-back -- which fails with `client_id (null)`/`redirect_uri (null)`.
 * There is no way to detect this in advance (this process cannot see the
 * browser's cookies), so the fix is operator action: sign in first, then
 * retry. Confirmed live against `content-test.byui.edu`.
 */
export async function loginAction(env: Env = process.env, deps: LoginDeps = {}): Promise<void> {
  const cfg = loadConfig(env);
  if (cfg.authMode === 'password') throw new OeqError(PASSWORD_MODE_NO_LOGIN);
  const tokenStore = deps.tokenStore ?? new FileTokenStore();
  const auth = new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, tokenStore);

  console.log(
    `Step 1: if you are not already signed in to openEQUELLA in this browser, open ${cfg.baseUrl} ` +
      `and sign in via SSO first -- skip this if you're already signed in.\n` +
      `Step 2: once signed in, come back here; the URL below will be opened for you.\n\n` +
      `(Why: a cold SSO session drops the query string on the bounce-back to openEQUELLA, which ` +
      `then fails with "No OAuth client can be found with the supplied client_id (null) and ` +
      `redirect_uri (null)". This process cannot detect your browser's session, so if you see that ` +
      `error: sign in at ${cfg.baseUrl}, then run \`oeq-upload login\` again -- or just re-open the ` +
      `URL printed below once you're signed in.)\n`,
  );

  const url = auth.getAuthorizeUrl();
  const loopback = loopbackTarget(cfg.redirectUri);

  if (loopback) {
    console.log(
      `Using loopback capture: OEQ_REDIRECT_URI (${cfg.redirectUri}) points at a local address, so ` +
        `this tool will start a temporary local server at ${loopback.hostname}:${loopback.port} and ` +
        `capture the code automatically once you sign in and authorize -- nothing to paste.\n`,
    );
  } else {
    console.log(
      `Using manual paste: OEQ_REDIRECT_URI (${cfg.redirectUri}) is not a loopback address, so this ` +
        `tool cannot capture the code automatically. openEQUELLA's home page discards the '?code=' ` +
        `query string almost immediately after it loads, so copying it straight out of the address ` +
        `bar is a race you will usually lose. The reliable way: after you sign in and click ` +
        `Authorize, open your browser's HISTORY and look for the entry containing '?code=' -- it is ` +
        `recorded there even though the address bar has already moved on to /page/home. Paste that ` +
        `whole URL below (or just the code, if you already isolated it).\n`,
    );
  }

  console.log(`Open this URL in a browser and sign in:\n\n  ${url}\n`);
  try {
    (deps.openBrowser ?? defaultOpenBrowser)(url);
  } catch {
    // Best-effort only -- the URL above already covers headless/SSH use.
  }

  let code: string;
  if (loopback) {
    console.log('Waiting for openEQUELLA to redirect back to this machine...');
    try {
      code = await (deps.captureLoopbackCode ?? defaultCaptureLoopbackCode)(cfg.redirectUri);
    } catch (err) {
      throw new OeqError(
        `Could not capture the code automatically at ${cfg.redirectUri}: ${errorMessage(err)}. Check ` +
          `that nothing else is using that port, or point OEQ_REDIRECT_URI at a non-loopback address ` +
          `to fall back to the manual-paste flow.`,
      );
    }
    console.log('Code captured automatically from the local redirect.');
  } else {
    const raw = (await (deps.promptForCode ?? defaultPromptForCode)()).trim();
    if (!raw) {
      throw new OeqError('No code entered. Run `oeq-upload login` again when you have it.');
    }
    code = extractCode(raw);
  }

  await auth.exchangeCode(code);

  const client = new OeqClient(cfg.baseUrl, auth);
  // A token exchange that succeeded is still not a sign-in: openEQUELLA
  // answers as the guest identity rather than refusing, so without this the
  // command prints "Logged in as guest ( )" and caches a token that can create
  // nothing. See core/identity.ts.
  const user = assertNotGuest(
    await client.currentUser(),
    'Run `oeq-upload login` again, and check OEQ_CLIENT_ID, OEQ_CLIENT_SECRET and OEQ_REDIRECT_URI ' +
      'against what your administrator registered for this site.',
  );
  console.log(`\nLogged in as ${user.username} (${user.firstName} ${user.lastName}).`);

  const raw = await tokenStore.loadRaw();
  console.log(
    tokenStore instanceof FileTokenStore ? `Token cached at ${tokenStore.path}.` : 'Token cached.',
  );
  console.log(
    raw?.expiresAt
      ? `Expires around ${new Date(raw.expiresAt).toISOString()} (server-reported).`
      : 'Server did not report an expiry.',
  );

  if (cfg.authMode === 'client_credentials') {
    console.log(
      '\nNote: OEQ_AUTH_MODE is currently "client_credentials" -- this cached token is only used ' +
        'once you switch it (or unset it, "code" is the default) to "code".',
    );
  }
}

export interface LogoutDeps {
  tokenStore?: TokenStore;
  /**
   * A live password-mode provider whose openEQUELLA session should be ended.
   *
   * Optional, and a plain `oeq-upload logout` run holds none: password mode
   * signs in once per process, so by the time this command starts there is no
   * JSESSIONID in THIS process to end -- building a provider here would only
   * mint a fresh session in order to destroy it. A caller that DOES hold one
   * (a long-lived front end, or a test) passes it, and the session is ended
   * on the server rather than left to time out there.
   */
  auth?: { logout(): Promise<LogoutOutcome> };
}

/**
 * `env` is the SECOND parameter, unusually, because `deps` was already first
 * and every existing caller passes it positionally.
 *
 * Unlike `login`, this still does its work in password mode instead of
 * refusing: clearing the store is the one genuinely useful thing left, since
 * an operator who switched over from an OAuth mode can still have a stale
 * token file on disk. What changes is only the message -- announcing "the
 * cached token has been removed" to someone whose mode never cached one is a
 * small lie that invites them to believe they had a session.
 */
export async function logoutAction(deps: LogoutDeps = {}, env: Env = process.env): Promise<void> {
  const tokenStore = deps.tokenStore ?? new FileTokenStore();
  await tokenStore.clear();
  // Reads the raw variable rather than going through loadConfig: logging out
  // must keep working when the config is incomplete or invalid, which is
  // exactly when someone reaches for it.
  if (env.OEQ_AUTH_MODE === 'password') {
    if (deps.auth) {
      // Before the message, not after: under password auth the JSESSIONID
      // stays valid on the SERVER until openEQUELLA times it out, so "logged
      // out" is not true until this has run. It never throws -- and it now
      // reports what it established, because never throwing used to mean the
      // message below was printed over a logout that had failed.
      const outcome = await deps.auth.logout();
      if (outcome === 'unconfirmed') {
        console.log(
          'Logged out here, but the site did not confirm that the openEQUELLA session ended. ' +
            'It will expire on its own; sign out in a browser if you need it gone now. ' +
            'Any token left over from an earlier OAuth setup has been removed.',
        );
      } else if (outcome === 'no-session') {
        console.log(
          'Logged out. This process held no live openEQUELLA session to end. ' +
            'Any token left over from an earlier OAuth setup has been removed.',
        );
      } else {
        console.log(
          'Logged out, and the openEQUELLA session has been ended on the server. ' +
            'Any token left over from an earlier OAuth setup has been removed.',
        );
      }
      return;
    }
    console.log(
      'Password mode does not cache a token -- your username and password are read from ' +
        'OEQ_USERNAME and OEQ_PASSWORD on every run, so this command had no live session to ' +
        'end. Any token left over from an earlier OAuth setup has been removed.',
    );
    return;
  }
  console.log('Logged out. The cached token has been removed.');
}

export interface CheckDeps {
  tokenStore?: TokenStore;
  client?: OeqClient;
}

/**
 * Read-only pre-flight (see core/preflight.ts): confirms the address, a
 * token, which sign-in method produced it, identity, that the target
 * collection exists on THIS host, that this user can contribute to it at
 * all, and that its schema declares the fields duplicate detection and the
 * attachment-uuid field depend on. Creates nothing.
 *
 * It is also the compatibility probe a new institution reports back with, so
 * every line is rendered -- including the ones that passed. Returns the
 * process exit code.
 */
export async function checkAction(env: Env = process.env, deps: CheckDeps = {}): Promise<number> {
  const cfg = loadConfig(env);
  console.log(`OEQ_BASE_URL: ${cfg.baseUrl}`);
  console.log(`OEQ_COLLECTION_UUID: ${cfg.collectionUuid}\n`);

  const auth = createAuthProvider(cfg, env, deps.tokenStore);
  const client = deps.client ?? new OeqClient(cfg.baseUrl, auth);

  const result = await runPreflight(cfg, auth, client);
  for (const c of result.checks) {
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.label}: ${c.message}`);
  }
  console.log(`\n${summarise(result)}`);
  return result.ok ? 0 : 1;
}

export function buildProgram(env: Env = process.env): Command {
  const program = new Command();
  program
    .name('oeq-upload')
    .description('Bulk-create openEQUELLA contributions from files + a spreadsheet');

  program
    .command('plan')
    .description('Validate a spreadsheet against files on disk and write a job manifest. Uploads nothing.')
    .requiredOption('--sheet <path>', 'metadata spreadsheet (.xlsx or .csv)')
    .requiredOption('--files <dir>', 'directory containing the files')
    .option('--manifest <path>', 'where to write the job manifest', 'job.json')
    .option('--schema-file <path>', 'local schema export', 'schema/_entity.xml')
    .option('--state <state>', 'draft or published', 'draft')
    .option('--skip-duplicate-check', 'skip the pre-flight identifier duplicate check')
    .option('--upload-duplicates', 'upload rows that look like duplicates instead of skipping them')
    .action(async (o: PlanCliOptions) => {
      await planAction(o, env);
    });

  program
    .command('run')
    .description('Upload every pending row in a job manifest, resumably.')
    .requiredOption('--manifest <path>', 'job manifest from `plan`')
    .option('--force-interrupted', 'process rows left mid-upload by an interrupted prior run')
    .option('--max-attempts <n>', 'max attempts per row', (v) => parseInt(v, 10))
    .action(async (o: RunCliOptions) => {
      process.exitCode = await runAction(o, env);
    });

  program
    .command('status')
    .description('Summarize a job manifest\'s progress.')
    .requiredOption('--manifest <path>', 'job manifest')
    .action(async (o: StatusCliOptions) => {
      await statusAction(o);
    });

  program
    .command('retry')
    .description('Reset failed rows to pending so the next `run` retries them.')
    .requiredOption('--manifest <path>', 'job manifest')
    .action(async (o: RetryCliOptions) => {
      await retryAction(o);
    });

  program
    .command('login')
    .description(
      'Authenticate via the openEQUELLA authorization-code flow and cache a token for `run`/`check`.',
    )
    .action(async () => {
      await loginAction(env);
    });

  program
    .command('logout')
    .description(
      'Remove the cached OAuth token. In password mode there is no cached token to remove and ' +
        'no session held between runs, so this reports that rather than claiming a logout.',
    )
    .action(async () => {
      await logoutAction({}, env);
    });

  program
    .command('check')
    .description(
      'Read-only pre-flight and compatibility probe. Nine checks: https, authentication, sign-in ' +
        'method, identity, collections available, the target collection, CREATE_ITEM on it, the ' +
        'attachment-uuid field, and whether duplicate detection can work. Run this first at a new ' +
        'institution -- each failure says what it means for a real run. Creates nothing.',
    )
    .action(async () => {
      process.exitCode = await checkAction(env);
    });

  program
    .command('extract')
    .description('build a spreadsheet from a folder of PDFs and .docx files')
    .requiredOption('--dir <path>', 'folder of files to read')
    .requiredOption('--profile <path>', 'extraction profile (.profile.json)')
    .option('--out <path>', 'where to write the spreadsheet', 'extracted.csv')
    .option('--schema-file <path>', 'local schema export', 'schema/_entity.xml')
    .option('--dry-run', 'show the first few rows without writing anything')
    .option('--init-profile', 'write a starter profile for this folder, then stop')
    .option(
      '--ai',
      'let a language model fill the columns whose profile asks for one, using ' +
        'OEQ_MODEL_BASE_URL, OEQ_MODEL, OEQ_MODEL_KEY, OEQ_MODEL_BUDGET and OEQ_MODEL_CAP',
    )
    // NOT A PROMPT. `--ai` against a remote endpoint prints what it is about to
    // send and stops unless this is given: a scheduled job has no terminal, so
    // asking would either hang for ever or read EOF and call it consent. See
    // `approve` in cli/extract.ts.
    .option('--yes', 'agree in advance to what --ai says it will send, for an unattended run')
    .action(async (o: ExtractCliOptions) => {
      await runExtract(o, (message) => console.log(message));
    });

  return program;
}

/**
 * A BOM (U+FEFF) at the start of a `.env` file -- e.g. from PowerShell
 * 5.1's `Set-Content -Encoding utf8`, which plenty of Windows editors and
 * scripts also default to -- survives `process.loadEnvFile()` as part of
 * the *first* key's name rather than being stripped, so `OEQ_BASE_URL=...`
 * lands in the environment as `\uFEFFOEQ_BASE_URL`. `loadConfig()` then
 * reports `OEQ_BASE_URL` as missing even though the file plainly has it --
 * which reads like a typo, not an encoding problem, and only the file's
 * first variable is ever affected, making it an easy trap to walk into
 * repeatedly on this platform.
 *
 * Pure and side-effect-free (takes/returns a plain object, never touches
 * `process.env` itself) so it can be unit tested directly against a
 * BOM-prefixed key, without writing a real BOM'd file to disk -- see
 * `loadDotEnv()` below for where the fix is actually applied to
 * `process.env`. Returns the same object by reference when there is
 * nothing to fix, so a caller can cheaply tell whether anything changed.
 */
export function stripBomFromEnvKeys(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const BOM = '\uFEFF';
  if (!Object.keys(env).some((key) => key.startsWith(BOM))) return env;

  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key.startsWith(BOM) ? key.slice(BOM.length) : key] = value;
  }
  return result;
}

async function loadDotEnv(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const fixed = stripBomFromEnvKeys(process.env);
  if (fixed !== process.env) {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('\uFEFF')) delete process.env[key];
    }
    for (const [key, value] of Object.entries(fixed)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  await loadDotEnv();
  const program = buildProgram(process.env);
  await program.parseAsync(process.argv);
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    await main();
  } catch (err) {
    // Operator-facing errors (bad input, lock conflicts, API failures) print
    // cleanly with no stack trace -- they're not bugs. Anything else is a
    // genuine bug, and hiding its stack would help nobody debug it.
    if (err instanceof OeqError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
