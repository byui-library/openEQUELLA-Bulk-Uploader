#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../core/config.js';
import { readSheet } from '../core/sheet.js';
import { extractDefinition, parseSchemaPaths } from '../core/schema.js';
import { buildManifest, preflightDuplicates } from '../core/plan.js';
import { saveManifest, loadManifest } from '../core/state.js';
import { OAuthClientCredentials } from '../core/auth.js';
import { OeqClient } from '../core/client.js';
import { runManifest } from '../core/runner.js';
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
    const client = new OeqClient(
      cfg.baseUrl,
      new OAuthClientCredentials(cfg.baseUrl, cfg.clientId, cfg.clientSecret),
    );
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
  const client = new OeqClient(
    cfg.baseUrl,
    new OAuthClientCredentials(cfg.baseUrl, cfg.clientId, cfg.clientSecret),
  );
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

  return program;
}

async function loadDotEnv(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
