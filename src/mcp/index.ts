#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync, openSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, createAuthProvider, type Config } from '../core/config.js';
import { readSheet } from '../core/sheet.js';
import {
  extractDefinition,
  extractItemNamePath,
  parseSchemaPaths,
  validateHeaders,
  suggest,
} from '../core/schema.js';
import { buildManifest, preflightDuplicates } from '../core/plan.js';
import { findDuplicates, type DuplicateFinding } from '../core/duplicates.js';
import { saveManifest, loadManifest } from '../core/state.js';
import { checkLock, type LockInfo } from '../core/lock.js';
import { AuthorizationCodeAuth } from '../core/authCode.js';
import { FileTokenStore, type TokenStore } from '../core/tokenStore.js';
import { redactSecret as redactAllForms } from '../core/redact.js';
import { OeqClient } from '../core/client.js';
import { runPreflight, summarise } from '../core/preflight.js';
import type { ItemState } from '../core/types.js';

type Env = Record<string, string | undefined>;

interface ToolResult {
  // Index signature to satisfy the SDK's CallToolResult shape (it extends a
  // generic result envelope with `[x: string]: unknown`), without pulling in
  // the SDK's own type just for this.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const text = (s: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: s }],
  ...(isError ? { isError: true } : {}),
});

/**
 * A caught exception's `.message` (or, for OeqError from loadConfig/plan/
 * state, an operator-facing sentence) is exactly what a human wants to read
 * in the conversation transcript -- see the module doc below for why every
 * tool catches broadly and renders text instead of letting an exception
 * become an opaque protocol-level failure.
 */
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `oeq_plan` is the only tool here that ever loads config, so it's the only
 * one that ever has `OEQ_CLIENT_SECRET` in scope. This is a last line of
 * defense, not the primary control: nothing in `buildManifest` or
 * `loadConfig`'s own error text interpolates the secret. But tool results
 * land directly in a conversation transcript, so a stray future change that
 * accidentally stringifies the whole config object must not silently leak
 * credentials into it.
 *
 * Delegates to core/redact.ts rather than matching the literal secret alone.
 * The secret travels in a query string, so an ApiError carrying an echoed
 * request line holds an ENCODED form -- and a literal-only match would sail
 * straight past it into the transcript. The empty-secret guard lives in the
 * core helper.
 *
 * Exported for test: the wrapper is the shim that binds the core helper to
 * this layer's env lookup, and that binding is what needs proving.
 */
export function redactSecret(message: string, env: Env): string {
  return redactAllForms(message, env.OEQ_CLIENT_SECRET ?? '');
}

async function loadPaths(schemaFile: string): Promise<Set<string>> {
  return parseSchemaPaths(extractDefinition(await readFile(schemaFile, 'utf8')));
}

/**
 * The title xpath the schema export declares, or null when it declares none.
 *
 * The duplicate check searches on this. Assuming `MWDL/title` would make it
 * match nothing at any institution whose schema says otherwise, and a check
 * that matches nothing reports every row clean. Null is passed through as
 * "could not check" rather than replaced by a guess.
 */
async function loadTitleHeader(schemaFile: string): Promise<string | null> {
  return extractItemNamePath(await readFile(schemaFile, 'utf8'));
}

/**
 * "Credentials" here means the OAuth client id + secret specifically --
 * `OEQ_BASE_URL` is target configuration (which instance), not a secret, and
 * is required regardless of this check: `buildManifest` records it in the
 * manifest for the later `run` step, so `oeq_plan` still can't do anything
 * useful without it.
 */
/**
 * Which variables count as "credentials" depends on the auth mode: an
 * institution using password auth has no OAuth client at all, so gating on
 * OEQ_CLIENT_ID would make planning permanently credential-less for them and
 * the skip warning below would name variables they can never set.
 */
function isPasswordMode(env: Env): boolean {
  return env.OEQ_AUTH_MODE === 'password';
}

/** The variables `hasCredentials` gates on, for use in operator-facing text. */
function credentialNames(env: Env): string {
  return isPasswordMode(env) ? 'OEQ_USERNAME/OEQ_PASSWORD' : 'OEQ_CLIENT_ID/OEQ_CLIENT_SECRET';
}

function hasCredentials(env: Env): boolean {
  return isPasswordMode(env)
    ? Boolean(env.OEQ_USERNAME) && Boolean(env.OEQ_PASSWORD)
    : Boolean(env.OEQ_CLIENT_ID) && Boolean(env.OEQ_CLIENT_SECRET);
}

/**
 * `loadConfig` gates on `OEQ_BASE_URL`, `OEQ_CLIENT_ID`, and
 * `OEQ_CLIENT_SECRET` together, all-or-nothing -- but `buildManifest` only
 * ever needs `baseUrl`/`collectionUuid`/`schemaUuid` from it, and never
 * touches the network. Planning (matching spreadsheet rows to files,
 * catching header typos) is genuinely useful offline and must keep working
 * even when the operator hasn't finished wiring up OAuth credentials yet --
 * that's a very normal state, not a broken one.
 *
 * When the real credentials are absent, this substitutes inert placeholders
 * for just the two credential fields so the *real*, unmodified `loadConfig`
 * still computes the real `baseUrl`, collection and attachment-uuid path --
 * there is no local, drift-prone copy of that logic here. The placeholders
 * must never be trusted for anything network-related; every caller of this
 * function checks `hasCredentials(env)` (the original env, not the patched
 * one) before ever reading `cfg.clientId`/`cfg.clientSecret`.
 *
 * `OEQ_COLLECTION_UUID` is NOT substituted, and planning without it fails.
 * It is target configuration rather than a credential, `buildManifest`
 * records it for the later `run`, and a manifest without one is rejected at
 * load -- so a placeholder here would only move the failure to a point where
 * the operator has already built a plan they cannot run.
 */
function loadConfigForPlanning(env: Env): Config {
  if (hasCredentials(env)) return loadConfig(env);
  return isPasswordMode(env)
    ? loadConfig({ ...env, OEQ_USERNAME: 'unset', OEQ_PASSWORD: 'unset' })
    : loadConfig({ ...env, OEQ_CLIENT_ID: 'unset', OEQ_CLIENT_SECRET: 'unset' });
}

/**
 * Shared refusal text for `oeq_plan`, `oeq_retry_failed`, and `oeq_start_job`
 * -- the three tools that would otherwise read-modify-write (or spawn a
 * second writer against) a manifest a detached runner may still be mid-way
 * through. See lock.ts's module doc for the full duplicate-upload hazard
 * this guards against.
 */
function lockRefusalMessage(manifestPath: string, lock: LockInfo, action: string): string {
  return (
    `Manifest ${manifestPath} is locked by process ${lock.pid}` +
    (lock.startedAt ? ` (started ${lock.startedAt})` : '') +
    `. Refusing to ${action} while a run may be in progress -- doing so would risk ` +
    `overwriting its progress with a stale snapshot and causing a duplicate upload. Wait for ` +
    `it to finish, or confirm the process is really gone before deleting ${manifestPath}.lock ` +
    `by hand.`
  );
}

// ---------------------------------------------------------------------------
// Tool implementations, factored out as plain async functions so tests can
// call them directly instead of driving the MCP server over stdio.
// ---------------------------------------------------------------------------

export interface ListSchemaPathsArgs {
  filter?: string;
  schemaFile?: string;
}

/** Search the ~158 valid metadata xpaths. Exact substring hits win; if none,
 *  fall back to nearest-match suggestions so a near-miss guess still helps. */
export async function listSchemaPaths(args: ListSchemaPathsArgs): Promise<ToolResult> {
  const schemaFile = args.schemaFile ?? 'schema/_entity.xml';
  try {
    const paths = await loadPaths(schemaFile);
    if (!args.filter) return text([...paths].sort().join('\n'));
    const filterLower = args.filter.toLowerCase();
    const exact = [...paths].filter((p) => p.toLowerCase().includes(filterLower)).sort();
    const near = exact.length > 0 ? [] : suggest(args.filter, paths, 10);
    return text([...exact, ...near].join('\n') || 'No matching xpaths.');
  } catch (err) {
    return text(errorMessage(err), true);
  }
}

export interface ValidateSheetArgs {
  sheet: string;
  schemaFile?: string;
}

/** Check a spreadsheet's headers against the schema, with suggestions for
 *  anything invalid -- the main value of the conversational path. */
export async function validateSheetTool(args: ValidateSheetArgs): Promise<ToolResult> {
  const schemaFile = args.schemaFile ?? 'schema/_entity.xml';
  try {
    const parsed = await readSheet(resolve(args.sheet));
    const { valid, invalid } = validateHeaders(parsed.headers, await loadPaths(schemaFile));
    const lines = [
      `${parsed.rows.length} data row(s), ${parsed.headers.length} column(s).`,
      `Valid headers: ${valid.length}`,
    ];
    if (invalid.length === 0) {
      lines.push('All headers are valid.');
    } else {
      for (const i of invalid) {
        lines.push(
          `INVALID '${i.header}'` +
            (i.suggestions.length > 0 ? ` -- did you mean: ${i.suggestions.join(', ')}?` : ''),
        );
      }
    }
    return text(lines.join('\n'));
  } catch (err) {
    return text(errorMessage(err), true);
  }
}

export interface PlanArgs {
  sheet: string;
  filesDir: string;
  manifestPath?: string;
  /**
   * String, not `ItemState`: this function may be called directly (bypassing
   * the zod enum on the registered tool, which is what actually keeps a
   * malformed value from ever reaching here over MCP -- see the tool
   * registration below), so it re-validates rather than trusting the type.
   * Publishing 37 items live into a collection with no moderation workflow
   * is the worst outcome this tool can produce; a typo here must fail loud,
   * not silently default to something plausible-looking.
   */
  itemState?: string;
  schemaFile?: string;
  /**
   * Skip the network check for existing duplicate identifiers. Default
   * false, matching the CLI's `plan` command -- the check is cheap, advisory
   * (see `preflightDuplicates`'s own doc in plan.ts), and is exactly the
   * kind of thing the *less* spreadsheet-savvy MCP audience benefits most
   * from having on by default.
   */
  skipDuplicateCheck?: boolean;
}

/**
 * Validate a spreadsheet against files on disk and write a job manifest,
 * then (unless skipped) run the same advisory duplicate-identifier check
 * `planAction` runs in src/cli/index.ts, so a manifest planned via MCP
 * carries the same warnings one planned via the CLI would -- see
 * `loadConfigForPlanning` above for why a missing OAuth credential degrades
 * to a warning here instead of failing the whole call.
 *
 * MUST check the lock before doing anything else: `oeq_start_job` detaches
 * the runner, so an agent can call this mid-job. Writing a stale snapshot
 * over the runner's progress would revert a `created` entry to `pending` and
 * cause a duplicate ~150 MB upload on the next run. See lock.ts.
 */
export async function planTool(args: PlanArgs, env: Env = process.env): Promise<ToolResult> {
  const manifestPath = args.manifestPath ?? 'job.json';

  const lock = await checkLock(manifestPath);
  if (lock) {
    return text(lockRefusalMessage(manifestPath, lock, 'plan (this would write the manifest)'), true);
  }

  const itemStateRaw = args.itemState ?? 'draft';
  if (itemStateRaw !== 'draft' && itemStateRaw !== 'published') {
    return text(
      `itemState must be 'draft' or 'published', got '${itemStateRaw}'. Refusing to guess -- ` +
        `this collection has no moderation workflow, so a wrong value here would publish live.`,
      true,
    );
  }
  const itemState: ItemState = itemStateRaw;
  const schemaFile = args.schemaFile ?? 'schema/_entity.xml';
  const skipDuplicateCheck = args.skipDuplicateCheck ?? false;
  // Declared outside the try so it's still in scope when the response is
  // built below. This layer only ever reports these -- it never skips, marks
  // or filters a row on their account. Deciding what to do about a finding
  // belongs to whoever is uploading, the same separation that keeps file
  // bytes out of this layer.
  let duplicates: DuplicateFinding[] = [];

  try {
    const cfg = loadConfigForPlanning(env);
    const sheet = await readSheet(resolve(args.sheet));
    const paths = await loadPaths(schemaFile);
    const manifest = await buildManifest(sheet, resolve(args.filesDir), paths, {
      baseUrl: cfg.baseUrl,
      collectionUuid: cfg.collectionUuid,
      schemaUuid: cfg.schemaUuid,
      itemState,
      attachmentUuidPath: cfg.attachmentUuidPath,
    });

    // Mirrors planAction exactly: warnings land in manifest.warnings BEFORE
    // saveManifest, so a manifest planned here and one planned via the CLI
    // carry identical persisted state, not just identical console output.
    if (!skipDuplicateCheck) {
      if (!hasCredentials(env)) {
        manifest.warnings.push(
          `Duplicate check skipped: ${credentialNames(env)} are not configured, so ` +
            'existing identifiers in the collection could not be checked. Configure them ' +
            'and re-plan (or pass skipDuplicateCheck) once ready.',
        );
      } else {
        // Guards only the setup (client construction) -- preflightDuplicates
        // itself already survives a per-entry network failure and turns it
        // into its own per-row warning; this is a backstop for anything
        // unexpected happening before that point.
        try {
          const client = new OeqClient(cfg.baseUrl, createAuthProvider(cfg, env));
          const dupWarnings = await preflightDuplicates(client, manifest);
          manifest.warnings.push(...dupWarnings);
          duplicates = await findDuplicates(client, manifest, await loadTitleHeader(schemaFile));
        } catch (err) {
          manifest.warnings.push(`Duplicate check skipped: ${errorMessage(err)}`);
        }
      }
    }

    await saveManifest(manifestPath, manifest);
    const lines = [
      `Planned ${manifest.entries.length} item(s) -> ${manifestPath}`,
      `State: ${manifest.itemState}`,
      ...manifest.warnings.map((w) => `warning: ${w}`),
    ];
    // Reported, never acted on: this tool plans, validates and monitors --
    // skipping a row is a decision for whoever uploads, made on the Review
    // screen or equivalent, not here.
    if (duplicates.length > 0) {
      lines.push(`Possible duplicates: ${duplicates.length} row(s) -- see the duplicates field.`);
      for (const d of duplicates) {
        lines.push(`  Row ${d.rowNumber}: ${d.fileName} -- ${d.tier}: ${d.detail}`);
      }
    }
    return text(redactSecret(lines.join('\n'), env));
  } catch (err) {
    return text(redactSecret(errorMessage(err), env), true);
  }
}

export interface StartJobArgs {
  manifestPath: string;
  logPath?: string;
}

/** Test-only escape hatch: override where the CLI entry point is found,
 *  without needing a real `dist/` build on disk. */
export interface StartJobDeps {
  entryPoint?: string;
}

/** Resolve `dist/cli/index.js` relative to this compiled module's own
 *  location (`dist/mcp/index.js`), the way the plan sketch prescribes -- this
 *  works regardless of the operator's cwd when the MCP server was launched. */
function defaultEntryPoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'cli', 'index.js');
}

/**
 * Spawn the CLI runner detached and return immediately; progress comes from
 * polling `oeq_job_status`. The MCP layer never streams file bytes itself --
 * a batch is ~37 files / 5.5 GB, and pushing that through a tool-call loop
 * would be slow and would burn conversation context.
 *
 * MUST refuse to spawn a second runner against an already-locked manifest --
 * two runners racing on the same manifest file is exactly the corruption
 * lock.ts exists to prevent, and unlike `oeq_plan`/`oeq_retry_failed` this
 * tool wouldn't even get a clean error from `acquireLock`: by the time the
 * spawned child got around to acquiring it, this call would already have
 * returned "started" to the conversation.
 */
export async function startJobTool(args: StartJobArgs, deps: StartJobDeps = {}): Promise<ToolResult> {
  const manifestPath = args.manifestPath;
  const logPath = args.logPath ?? 'job.log';

  try {
    const lock = await checkLock(manifestPath);
    if (lock) {
      return text(lockRefusalMessage(manifestPath, lock, 'start a new run'), true);
    }

    const entryPoint = deps.entryPoint ?? defaultEntryPoint();
    if (!existsSync(entryPoint)) {
      return text(
        `Cannot find the CLI runner at ${entryPoint}. This MCP server needs the project built ` +
          `first -- run \`npm run build\`, then try again.`,
        true,
      );
    }

    const out = openSync(logPath, 'a');
    const child = spawn(process.execPath, [entryPoint, 'run', '--manifest', manifestPath], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return text(`Started runner pid=${String(child.pid)} for ${manifestPath}. Log: ${logPath}`);
  } catch (err) {
    return text(errorMessage(err), true);
  }
}

export interface JobStatusArgs {
  manifestPath: string;
}

/** Read-only: counts by status, failures, interrupted rows, and the lock
 *  holder if any. Must work fine while locked -- this is the tool an agent
 *  polls after `oeq_start_job` while the runner is still going. */
export async function jobStatusTool(args: JobStatusArgs): Promise<ToolResult> {
  try {
    const m = await loadManifest(args.manifestPath);

    const counts: Record<string, number> = {};
    for (const e of m.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
    const lines = [JSON.stringify(counts)];

    const failed = m.entries.filter((e) => e.status === 'failed');
    if (failed.length > 0) {
      lines.push('Failed:');
      for (const e of failed) lines.push(`  row ${e.rowNumber} ${e.fileName}: ${e.error ?? 'unknown error'}`);
    }

    // 'uploading' at read time means a prior run died mid-row -- see runner.ts.
    const interrupted = m.entries.filter((e) => e.status === 'uploading');
    if (interrupted.length > 0) {
      lines.push('Interrupted (a prior run died mid-upload; verify in openEQUELLA before retrying):');
      for (const e of interrupted) lines.push(`  row ${e.rowNumber} ${e.fileName}: ${e.error ?? 'interrupted'}`);
    }

    const lock = await checkLock(args.manifestPath);
    lines.push(
      lock
        ? `Lock held by pid ${lock.pid} (started ${lock.startedAt}); a run may be in progress.`
        : 'No active lock.',
    );

    return text(lines.join('\n'));
  } catch (err) {
    return text(errorMessage(err), true);
  }
}

export interface RetryFailedArgs {
  manifestPath: string;
}

/**
 * Reset `failed` entries only -- to `pending`, `attempts: 0` -- so the next
 * run gives them a fresh attempt budget. Deliberately leaves `uploading`
 * (interrupted-at-load) entries untouched; only `run --force-interrupted`,
 * invoked at the moment of the run that will act on it, is the right
 * explicit acknowledgement for those (see cli/index.ts's `retryAction`,
 * which this mirrors).
 *
 * MUST check the lock before writing -- same hazard as `oeq_plan`.
 */
export async function retryFailedTool(args: RetryFailedArgs): Promise<ToolResult> {
  const manifestPath = args.manifestPath;

  const lock = await checkLock(manifestPath);
  if (lock) {
    return text(lockRefusalMessage(manifestPath, lock, 'retry (this would write the manifest)'), true);
  }

  try {
    const m = await loadManifest(manifestPath);
    let n = 0;
    for (const e of m.entries) {
      if (e.status === 'failed') {
        e.status = 'pending';
        e.attempts = 0;
        delete e.error;
        n++;
      }
    }
    await saveManifest(manifestPath, m);
    return text(`Reset ${n} failed entr${n === 1 ? 'y' : 'ies'} to pending.`);
  } catch (err) {
    return text(errorMessage(err), true);
  }
}

/**
 * Both login tools refuse in password mode for the same reason `oeq-upload
 * login` does (see cli/index.ts): there is no browser flow to start and no
 * token to cache, and a success result would read as "credentials verified"
 * when nothing was verified. `oeq_check` is what actually verifies them.
 */
const PASSWORD_MODE_NO_LOGIN =
  'Sign-in is not needed in password mode -- the username and password are read from ' +
  'OEQ_USERNAME and OEQ_PASSWORD on every call, so there is no browser flow and no token to ' +
  'cache. Call oeq_check to confirm they work.';

export interface LoginUrlDeps {
  tokenStore?: TokenStore;
}

/**
 * Returns the URL the operator opens in a browser to authenticate via the
 * authorization-code flow (see docs/SESSION-HANDOFF.md and authCode.ts) --
 * an MCP tool cannot itself drive a browser or read stdin, so the flow here
 * is split across two calls: this one and `oeq_login_complete` below.
 */
export async function loginUrlTool(env: Env = process.env, deps: LoginUrlDeps = {}): Promise<ToolResult> {
  try {
    const cfg = loadConfig(env);
    if (cfg.authMode === 'password') return text(PASSWORD_MODE_NO_LOGIN, true);
    const auth = new AuthorizationCodeAuth(
      cfg.baseUrl,
      cfg.clientId,
      cfg.clientSecret,
      cfg.redirectUri,
      deps.tokenStore,
    );
    const url = auth.getAuthorizeUrl();
    return text(
      `Open this URL in a browser and sign in:\n\n${url}\n\n` +
        "After signing in, the browser lands on the openEQUELLA home page. Find the 'code' " +
        "parameter in its address bar (e.g. '...?code=abcd1234') and pass just that value to " +
        'oeq_login_complete.',
    );
  } catch (err) {
    return text(redactSecret(errorMessage(err), env), true);
  }
}

export interface LoginCompleteArgs {
  code: string;
}

export interface LoginCompleteDeps {
  tokenStore?: TokenStore;
}

/**
 * Exchanges the code from `oeq_login_url` for a token, caches it (so a
 * detached `oeq_start_job` runner can pick it up), and confirms who is now
 * logged in -- the whole point of this flow is that created items are owned
 * by whoever ran this, not a fixed service account.
 */
export async function loginCompleteTool(
  args: LoginCompleteArgs,
  env: Env = process.env,
  deps: LoginCompleteDeps = {},
): Promise<ToolResult> {
  try {
    const cfg = loadConfig(env);
    if (cfg.authMode === 'password') return text(PASSWORD_MODE_NO_LOGIN, true);
    const tokenStore = deps.tokenStore ?? new FileTokenStore();
    const auth = new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, tokenStore);
    await auth.exchangeCode(args.code);
    const client = new OeqClient(cfg.baseUrl, auth);
    const user = await client.currentUser();
    return text(`Logged in as ${user.username} (${user.firstName} ${user.lastName}).`);
  } catch (err) {
    return text(redactSecret(errorMessage(err), env), true);
  }
}

export interface CheckDeps {
  tokenStore?: TokenStore;
  client?: OeqClient;
}

/**
 * An MCP caller has no shell to run `oeq-upload login` in -- see
 * preflight.ts's `loginHint` doc -- so this replaces runPreflight()'s
 * default CLI instruction with the MCP equivalent when the Token check
 * fails.
 */
const MCP_LOGIN_HINT = 'Call the oeq_login_url tool, then oeq_login_complete with the code';

/**
 * The same read-only checks `oeq-upload check` runs (see core/preflight.ts
 * -- shared with the CLI so the two front ends can't drift): the configured
 * address, a usable token, which sign-in method produced it, who it belongs
 * to, whether the target collection exists on THIS host, whether this user
 * can contribute anywhere at all and to that collection in particular, and
 * whether its schema declares the fields duplicate detection and the
 * attachment-uuid field depend on. Creates nothing.
 */
export async function checkTool(env: Env = process.env, deps: CheckDeps = {}): Promise<ToolResult> {
  try {
    const cfg = loadConfig(env);
    const auth = createAuthProvider(cfg, env, deps.tokenStore);
    const client = deps.client ?? new OeqClient(cfg.baseUrl, auth);
    const result = await runPreflight(cfg, auth, client, MCP_LOGIN_HINT);
    const lines = [
      `OEQ_BASE_URL: ${cfg.baseUrl}`,
      `OEQ_COLLECTION_UUID: ${cfg.collectionUuid}`,
      '',
      ...result.checks.map((c) => `[${c.pass ? 'PASS' : 'FAIL'}] ${c.label}: ${c.message}`),
      '',
      summarise(result),
    ];
    return text(redactSecret(lines.join('\n'), env), !result.ok);
  } catch (err) {
    return text(redactSecret(errorMessage(err), env), true);
  }
}

// ---------------------------------------------------------------------------
// Server wiring. There is deliberately no upload tool: this layer plans,
// validates, launches, and monitors -- it never streams file bytes.
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'oeq-bulk-uploader', version: '0.1.0' });

server.tool(
  'oeq_list_schema_paths',
  'Search the ~158 valid metadata xpaths for this openEQUELLA schema. Use this to find the ' +
    'right column header when building or fixing a batch spreadsheet.',
  {
    filter: z.string().optional().describe('Substring or near-match to search for, e.g. "creator"'),
    schemaFile: z.string().default('schema/_entity.xml').describe('Path to a local _entity.xml schema export'),
  },
  async (args) => listSchemaPaths(args),
);

server.tool(
  'oeq_validate_sheet',
  "Check a spreadsheet's column headers against the schema. Reports which headers are valid " +
    'and, for anything invalid, the nearest-match xpath suggestions.',
  {
    sheet: z.string().describe('Path to a .xlsx or .csv metadata spreadsheet'),
    schemaFile: z.string().default('schema/_entity.xml').describe('Path to a local _entity.xml schema export'),
  },
  async (args) => validateSheetTool(args),
);

server.tool(
  'oeq_plan',
  'Validate a spreadsheet against files on disk and write a job manifest. Uploads nothing. ' +
    'Refuses to run, and writes nothing, if the manifest is locked by a job still in progress.',
  {
    sheet: z.string().describe('Path to a .xlsx or .csv metadata spreadsheet'),
    filesDir: z.string().describe('Directory containing the files named in the attachment column'),
    manifestPath: z.string().default('job.json').describe('Where to write the job manifest'),
    itemState: z
      .enum(['draft', 'published'])
      .default('draft')
      .describe(
        "draft (default) or published. This collection has no moderation workflow, so " +
          "'published' puts every item live immediately -- confirm with the operator before " +
          'ever passing anything other than draft.',
      ),
    schemaFile: z.string().default('schema/_entity.xml').describe('Path to a local _entity.xml schema export'),
    skipDuplicateCheck: z
      .boolean()
      .default(false)
      .describe(
        'Skip the network check for existing duplicate identifiers in the collection. Off by ' +
          'default; the check is advisory (never removes or blocks an entry) and is skipped ' +
          'automatically with a warning if OAuth credentials are not configured.',
      ),
  },
  async (args) => planTool(args),
);

server.tool(
  'oeq_start_job',
  'Start the upload runner as a detached background process and return immediately. Poll ' +
    'oeq_job_status for progress -- this tool never streams file bytes itself. Refuses to start ' +
    'a second runner if the manifest is already locked by one still in progress.',
  {
    manifestPath: z.string().describe('Job manifest from oeq_plan'),
    logPath: z.string().default('job.log').describe('Where the runner appends its progress log'),
  },
  async (args) => startJobTool(args),
);

server.tool(
  'oeq_job_status',
  'Report progress for a job manifest: counts by status, any failures with their error, any ' +
    'rows left over from an interrupted prior run, and whether a run is currently in progress. ' +
    'Read-only -- safe to call at any time, including while locked.',
  { manifestPath: z.string().describe('Job manifest to inspect') },
  async (args) => jobStatusTool(args),
);

server.tool(
  'oeq_retry_failed',
  'Reset failed entries in a job manifest to pending so the next oeq_start_job run retries ' +
    'them. Refuses to run, and writes nothing, if the manifest is locked by a job still in progress.',
  { manifestPath: z.string().describe('Job manifest to reset failures in') },
  async (args) => retryFailedTool(args),
);

server.tool(
  'oeq_login_url',
  'Get the URL to open in a browser to authenticate via the openEQUELLA authorization-code ' +
    'flow (Okta SSO). This instance\'s OAuth client has no fixed user, so each session needs a ' +
    'human to sign in once; the resulting code goes to oeq_login_complete. Read-only, creates nothing.',
  {},
  async () => loginUrlTool(),
);

server.tool(
  'oeq_login_complete',
  'Exchange the code from the oeq_login_url redirect for an access token, cache it for ' +
    'subsequent tools and a detached oeq_start_job runner, and confirm who is now logged in -- ' +
    'that user will own every item created from here on.',
  {
    code: z
      .string()
      .describe(
        "The 'code' query parameter from the address bar after signing in via the oeq_login_url link",
      ),
  },
  async (args) => loginCompleteTool(args),
);

server.tool(
  'oeq_check',
  'Read-only pre-flight, run before any upload: confirms a cached token exists, who it belongs ' +
    'to (whoever runs oeq_login_complete owns every item created), whether the target collection ' +
    '(OEQ_COLLECTION_UUID) exists on OEQ_BASE_URL, and whether that user actually holds ' +
    'CREATE_ITEM on it. Creates nothing.',
  {},
  async () => checkTool(),
);

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await server.connect(new StdioServerTransport());
}
