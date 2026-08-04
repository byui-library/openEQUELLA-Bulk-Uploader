#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { loadConfig, createAuthProvider } from '../core/config.js';
import { readSheet } from '../core/sheet.js';
import { extractDefinition, parseSchemaPaths } from '../core/schema.js';
import { buildManifest, preflightDuplicates } from '../core/plan.js';
import { saveManifest, loadManifest } from '../core/state.js';
import { OAuthClientCredentials } from '../core/auth.js';
import { AuthorizationCodeAuth } from '../core/authCode.js';
import { FileTokenStore, type TokenStore } from '../core/tokenStore.js';
import { OeqClient } from '../core/client.js';
import { runManifest } from '../core/runner.js';
import { runPreflight } from '../core/preflight.js';
import { checkLock } from '../core/lock.js';
import { OeqError, ValidationError } from '../core/errors.js';
import type { ItemState } from '../core/types.js';

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
}

export async function planAction(o: PlanCliOptions, env: Env = process.env): Promise<void> {
  const itemState = parseItemState(o.state);
  const cfg = loadConfig(env);

  const sheet = await readSheet(resolve(o.sheet));
  const paths = parseSchemaPaths(extractDefinition(await readFile(o.schemaFile, 'utf8')));
  const manifest = await buildManifest(sheet, resolve(o.files), paths, {
    baseUrl: cfg.baseUrl,
    collectionUuid: cfg.collectionUuid,
    schemaUuid: cfg.schemaUuid,
    itemState,
  });

  if (!o.skipDuplicateCheck) {
    const client = new OeqClient(cfg.baseUrl, createAuthProvider(cfg, env));
    const dupWarnings = await preflightDuplicates(client, manifest);
    manifest.warnings.push(...dupWarnings);
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
function defaultOpenBrowser(url: string): void {
  if (process.platform === 'win32') {
    // `start` is a cmd.exe builtin, not an executable -- must go through
    // `cmd /c`. The empty '' argument is the window title `start` expects
    // as its first argument when the next one could be mistaken for it.
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

async function defaultPromptForCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question('Paste the code here: ');
  } finally {
    rl.close();
  }
}

export interface LoginDeps {
  tokenStore?: TokenStore;
  openBrowser?: (url: string) => void;
  promptForCode?: () => Promise<string>;
}

/**
 * Authenticate via the authorization-code flow and cache a token that `run`
 * (and a detached `oeq_start_job` runner) can pick up. Never fails just
 * because the browser couldn't be opened -- the URL is always printed too.
 */
export async function loginAction(env: Env = process.env, deps: LoginDeps = {}): Promise<void> {
  const cfg = loadConfig(env);
  const tokenStore = deps.tokenStore ?? new FileTokenStore();
  const auth = new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, tokenStore);

  const url = auth.getAuthorizeUrl();
  console.log(`Open this URL in a browser and sign in:\n\n  ${url}\n`);
  try {
    (deps.openBrowser ?? defaultOpenBrowser)(url);
  } catch {
    // Best-effort only -- the URL above already covers headless/SSH use.
  }

  console.log(
    "After signing in, the browser lands on the openEQUELLA home page. Find the 'code' " +
      "parameter in its address bar (e.g. '...?code=abcd1234') and paste just that value below.",
  );
  const code = (await (deps.promptForCode ?? defaultPromptForCode)()).trim();
  if (!code) {
    throw new OeqError('No code entered. Run `oeq-upload login` again when you have it.');
  }

  await auth.exchangeCode(code);

  const client = new OeqClient(cfg.baseUrl, auth);
  const user = await client.currentUser();
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
}

export async function logoutAction(deps: LogoutDeps = {}): Promise<void> {
  const tokenStore = deps.tokenStore ?? new FileTokenStore();
  await tokenStore.clear();
  console.log('Logged out. The cached token has been removed.');
}

export interface CheckDeps {
  tokenStore?: TokenStore;
  client?: OeqClient;
}

/**
 * Read-only pre-flight (see core/preflight.ts): confirms a token, identity,
 * that the target collection exists on THIS host, and that this user can
 * actually contribute to it. Creates nothing. Returns the process exit code.
 */
export async function checkAction(env: Env = process.env, deps: CheckDeps = {}): Promise<number> {
  const cfg = loadConfig(env);
  console.log(`OEQ_BASE_URL: ${cfg.baseUrl}`);
  console.log(`OEQ_COLLECTION_UUID: ${cfg.collectionUuid}\n`);

  const auth =
    cfg.authMode === 'client_credentials'
      ? new OAuthClientCredentials(cfg.baseUrl, cfg.clientId, cfg.clientSecret)
      : new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, deps.tokenStore);
  const client = deps.client ?? new OeqClient(cfg.baseUrl, auth);

  const result = await runPreflight(cfg, auth, client);
  for (const c of result.checks) {
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.label}: ${c.message}`);
  }
  console.log(result.ok ? '\nAll checks passed.' : '\nOne or more checks failed -- see above.');
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
    .description('Remove the cached OAuth token.')
    .action(async () => {
      await logoutAction();
    });

  program
    .command('check')
    .description(
      'Read-only pre-flight: confirms auth, identity, and CREATE_ITEM on the target collection. Creates nothing.',
    )
    .action(async () => {
      process.exitCode = await checkAction(env);
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
