// src/cli/extract.ts
import { readFile, readdir } from 'node:fs/promises';
import { OeqError, ValidationError } from '../core/errors.js';
import {
  extractDefinition,
  extractItemDescriptionPath,
  extractItemNamePath,
  parseSchemaPaths,
} from '../core/schema.js';
import { loadProfile, saveProfile, validateAgainstSchema } from '../core/extract/profile.js';
import { starterProfile } from '../core/extract/suggest.js';
import { extractFolder, listFolder } from '../core/extract/extract.js';
import { scanEvidence } from '../core/extract/evidence.js';
import { writeCsv } from '../core/extract/csv.js';
import { aiConfirmation } from '../core/ai/confirm.js';
import { modelColumns } from '../core/ai/eligible.js';
import { noteMissingModel, type FillTarget } from '../core/ai/fill.js';
import { MODEL_DEFAULTS } from '../core/ai/defaults.js';
import { runModelPass, type ModelPassSettings } from '../core/ai/pass.js';
import { countModelWritten, countNeedingReview } from '../core/ai/review.js';
import type { Profile } from '../core/extract/types.js';

export interface ExtractCliOptions {
  dir: string;
  profile: string;
  out: string;
  schemaFile: string;
  dryRun?: boolean;
  initProfile?: boolean;
  /**
   * Let a language model fill the columns that asked for one.
   *
   * OFF BY DEFAULT AND OFF MEANS ABSENT. Without it nothing is read from the
   * environment, no endpoint is contacted, and a run is byte-for-byte what it
   * was before this feature existed -- which is what lets the tool be adopted
   * by an institution that has not had a data review.
   */
  ai?: boolean;
  /** Agree, in advance, to what `--ai` says it is about to send. See `approve`. */
  yes?: boolean;
}

const PREVIEW_ROWS = 5;

/**
 * The environment variables that configure a model, and the one that decides
 * whether there is one at all.
 *
 * `OEQ_MODEL_BASE_URL` IS THE SWITCH. Absent, there is no endpoint, so there is
 * nothing to send to and no partially-configured state to reason about -- the
 * same rule `secrets.ts#getModel` follows for the desktop, stated once per
 * surface because the two stores are different and the rule must not be.
 */
export const MODEL_ENV = {
  baseUrl: 'OEQ_MODEL_BASE_URL',
  model: 'OEQ_MODEL',
  key: 'OEQ_MODEL_KEY',
  budget: 'OEQ_MODEL_BUDGET',
  cap: 'OEQ_MODEL_CAP',
  /** Seconds, matching Setup's box rather than the code's milliseconds. Not in
   *  the plan's list, and here because `provider.ts` tells a timed-out operator
   *  to "allow more time" -- advice naming an action the CLI would not offer. */
  timeoutSeconds: 'OEQ_MODEL_TIMEOUT_SECONDS',
} as const;

/**
 * The model endpoint the environment describes, or null for "there is none".
 *
 * A MISTYPED NUMBER IS REFUSED HERE RATHER THAN COERCED. `Number('eight')` is
 * `NaN`, and a NaN cap compares false against everything -- so `used >= cap`
 * never fires, the ceiling the operator set silently does not exist, and every
 * row in the batch goes to a paid endpoint. `assertUsableCap` and
 * `assertUsableBudget` are the same one rule the settings screen asks, and
 * `fillWithModel` asks them again before the loop; this only decides that a
 * blank variable means "use the default" rather than "use nothing".
 */
export function modelFromEnv(env: NodeJS.ProcessEnv): ModelPassSettings | null {
  const baseUrl = env[MODEL_ENV.baseUrl]?.trim();
  if (!baseUrl) return null;
  const seconds = env[MODEL_ENV.timeoutSeconds]?.trim();
  return {
    baseUrl,
    model: env[MODEL_ENV.model]?.trim() ?? '',
    apiKey: env[MODEL_ENV.key]?.trim() ?? '',
    budget: numberOr(env[MODEL_ENV.budget], MODEL_DEFAULTS.budget),
    cap: numberOr(env[MODEL_ENV.cap], MODEL_DEFAULTS.cap),
    ...(seconds ? { timeoutMs: Number(seconds) * 1000 } : {}),
  };
}

/** A blank or unset variable takes the default; anything else is passed through
 *  as typed, including a value the rules below will refuse. Silently correcting
 *  a mistyped ceiling would hide the mistake and spend the money. */
function numberOr(raw: string | undefined, fallback: number): number {
  const text = raw?.trim();
  return text === undefined || text === '' ? fallback : Number(text);
}

/**
 * Show what is about to be sent, and stop unless the operator has already
 * agreed to it.
 *
 * ## It never reads stdin, and that is the decision
 *
 * `--ai` without `--yes` refuses, prints what it would have sent, and exits
 * non-zero. It does not prompt. A scheduled job's stdin is not a terminal, so a
 * prompt there either reads EOF immediately and treats it as an answer nobody
 * gave, or blocks for ever holding a nightly run open -- and a TTY check that
 * picks between prompting and refusing gives the command two behaviours, only
 * one of which anybody ever tests. Refusing is identical on a terminal and off
 * one, cannot hang, and cannot proceed unconfirmed.
 *
 * ## The words are the desktop's words
 *
 * `aiConfirmation` is the single copy, in `core/ai/confirm.ts`. An operator who
 * read the dialog on Monday and runs this on Tuesday is agreeing to the same
 * thing, described the same way.
 *
 * ## Null means there is nothing to agree to
 *
 * A local endpoint sends nothing off the machine and bills nothing; no column
 * asking for a model, no documents, or a cap of zero means no request is made
 * at all. `aiConfirmation` returns null for every one of those, and a null is
 * not a question -- so `--yes` is not required for any of them, exactly as the
 * desktop shows no dialog.
 */
function approve(
  options: ExtractCliOptions,
  profile: Profile,
  settings: ModelPassSettings,
  documents: number,
  log: (message: string) => void,
): void {
  const text = aiConfirmation({
    profile,
    documents,
    model: settings.model,
    baseUrl: settings.baseUrl,
    budget: settings.budget,
    cap: settings.cap,
  });
  if (text === null) return;
  if (options.yes !== true) {
    throw new ValidationError(
      `${text}\n\nNothing has been sent. Re-run with --yes to go ahead.`,
    );
  }
  log(text);
}

/**
 * `log` is injected so the command is testable without capturing stdout.
 *
 * `env` and `fetchImpl` are injected for a sharper reason: the promise that an
 * unconfigured institution has nothing sent anywhere is only a promise if
 * something can watch the socket. A test that had to mutate `process.env` could
 * be broken by another test running beside it, and a `fetch` nothing can see is
 * a guarantee nothing can check.
 */
export async function runExtract(
  options: ExtractCliOptions,
  log: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (options.initProfile) {
    const names = (await readdir(options.dir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
    // Read a sample of the documents, not just their names. Without this the
    // description column came out with NO sources at all and the Word files'
    // "Job Description" table was never mapped -- the CLI produced a profile
    // the desktop app would never have proposed.
    //
    // The declared name and description paths come from the export too, not
    // from a constant: proposing BYU-Idaho's `MWDL/...` against somebody else's
    // schema put three invalid columns in the operator's first output.
    const schemaXml = await readFile(options.schemaFile, 'utf8');
    const profile = starterProfile(
      names,
      {
        titleHeader: extractItemNamePath(schemaXml),
        descriptionHeader: extractItemDescriptionPath(schemaXml),
        paths: parseSchemaPaths(extractDefinition(schemaXml)),
      },
      await scanEvidence(options.dir),
    );
    await saveProfile(options.profile, profile);
    log(`Wrote a starter profile to ${options.profile}`);
    log(`Detected pattern: ${profile.pattern}`);
    log(`Add columns to it, then run extract again without --init-profile.`);
    return;
  }

  const profile = await loadProfile(options.profile);

  const schemaPaths = parseSchemaPaths(extractDefinition(await readFile(options.schemaFile, 'utf8')));
  const problems = validateAgainstSchema(profile, schemaPaths);
  if (problems.length > 0) {
    const detail = problems
      .map((p) => {
        const hint = p.suggestions.length > 0 ? ` -- did you mean ${p.suggestions.join(', ')}?` : '';
        return `  ${p.path}${hint}`;
      })
      .join('\n');
    throw new ValidationError(`Profile has columns that are not valid schema paths:\n${detail}`);
  }

  // NOTHING BELOW RUNS WHEN NO COLUMN ASKED FOR A MODEL. `modelColumns` is the
  // same function the confirmation counts with and the fill pass filters by, so
  // a column this profile could never write cannot make the run behave as if it
  // could -- see its docblock for the two that qualify by a quirk and are
  // excluded.
  const wantsModel = modelColumns(profile).length > 0;
  const settings = options.ai === true ? modelFromEnv(env) : null;

  /**
   * A DRY RUN SENDS NOTHING, EVEN WITH `--ai`.
   *
   * It is the flag an operator reaches for to check a profile before committing
   * to anything, and it shows five rows. Sending four hundred documents to a
   * paid endpoint to print five of the answers is a bill nobody asked for, and
   * it is the one shape of surprise this design spends its confirmation dialog
   * avoiding. The desktop reaches the same conclusion about its preview, for the
   * same reason.
   *
   * SAID OUT LOUD BELOW rather than quietly not happening -- a preview whose
   * model column is blank, with nothing explaining why, is a thing that could
   * not run looking exactly like a thing that ran and found nothing.
   */
  const dryRun = options.dryRun === true;

  if (options.ai === true && settings === null) {
    // An explicit instruction that cannot be carried out. Quietly writing "no
    // model is configured" into four hundred rows would answer a request nobody
    // could see had failed.
    throw new ValidationError(
      `--ai was given, but no model endpoint is configured. Set ${MODEL_ENV.baseUrl} ` +
        `(for example http://localhost:11434/v1 for a local model) and ${MODEL_ENV.model}.`,
    );
  }

  // Kept only when there is a pass to feed. `onRow` hands out the document that
  // was just read; holding four hundred of them for a run that will not send any
  // is memory spent on nothing.
  const runsModel = wantsModel && settings !== null && !dryRun;

  const targets: FillTarget[] = [];
  const collect = runsModel
    ? { onRow: (row: (typeof targets)[number]['row'], doc: (typeof targets)[number]['doc']) => {
        targets.push({ row, doc });
      } }
    : {};

  if (runsModel) {
    // BEFORE A SINGLE FILE IS OPENED. The count comes from the folder listing,
    // which is what the desktop's dialog uses too, so an operator who declines
    // has not paid for anything -- not even the reading.
    const { supported } = await listFolder(options.dir);
    approve(options, profile, settings!, supported.length, log);
  } else if (wantsModel && settings !== null) {
    log(
      `Dry run -- no model was asked anything and nothing was sent to ${settings.baseUrl}. ` +
        `The columns that would be filled by one are shown empty below. Run without --dry-run to fill them.`,
    );
  }

  const result = await extractFolder(options.dir, profile, collect);

  if (wantsModel && !dryRun) {
    if (settings === null) {
      // The column asked and there is nothing to ask. Said per cell, because a
      // silently empty cell is indistinguishable from a document that had
      // nothing to say -- the failure this codebase has shipped four times.
      noteMissingModel(result.rows, profile);
    } else {
      await runModelPass(targets, profile, settings, fetchImpl);
    }
  }


  if (result.skipped.length > 0) {
    log(`Skipped ${result.skipped.length} file(s):`);
    for (const { file, reason } of result.skipped) log(`  ${file} -- ${reason}`);
  }

  // A MODEL WRITE IS NOT A PROBLEM TO TRIAGE, and every one of them carries a
  // note -- so counting notes would report "400 of 400 need review" and bury the
  // batch's one genuine failure. Two numbers, because they answer two different
  // questions: what must I fix, and what did a machine write. See core/ai/review.ts.
  const withNotes = countNeedingReview(result.rows);
  if (withNotes > 0) {
    log(`${withNotes} of ${result.rows.length} row(s) need review -- see the _notes column.`);
  }
  const byModel = countModelWritten(result.rows);
  if (byModel > 0) {
    log(
      `${byModel} of ${result.rows.length} row(s) had a value written by a language model -- ` +
        `every one is flagged in the _notes column. Check them against the documents.`,
    );
  }

  if (options.dryRun) {
    log(`Dry run -- nothing written. First ${PREVIEW_ROWS} row(s):`);
    for (const row of result.rows.slice(0, PREVIEW_ROWS)) {
      const cells = profile.columns.map((c) => `${c.path}=${row.cells[c.path] ?? ''}`).join(' | ');
      log(`  ${cells}`);
    }
    return;
  }

  if (result.rows.length === 0) {
    throw new OeqError(`No readable files found in ${options.dir}; nothing to write.`);
  }

  await writeCsv(options.out, profile, result.rows);
  log(`Wrote ${result.rows.length} row(s) to ${options.out}`);
  log(`Open it, check the _notes column, then use it with 'oeq-upload plan'.`);
}
