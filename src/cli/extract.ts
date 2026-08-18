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
import { extractFolder, listFolder, type FolderListing } from '../core/extract/extract.js';
import { scanEvidence } from '../core/extract/evidence.js';
import { writeCsv } from '../core/extract/csv.js';
import { aiConfirmation } from '../core/ai/confirm.js';
import { describeHost } from '../core/ai/endpoint.js';
import { modelColumns } from '../core/ai/eligible.js';
import { noteMissingModel, type FillTarget, type MissingModelReason } from '../core/ai/fill.js';
import { MODEL_DEFAULTS } from '../core/ai/defaults.js';
import { assertUsableModelPass, runModelPass, type ModelPassSettings } from '../core/ai/pass.js';
import { assertUsableCap } from '../core/ai/fill.js';
import { assertUsableBudget } from '../core/ai/slice.js';
import { timeoutSecondsProblem } from '../core/ai/provider.js';
import { countModelWritten, countNeedingReview } from '../core/ai/review.js';
import type { DocumentData, ExtractedRow, Profile } from '../core/extract/types.js';

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
 * `OEQ_MODEL_BASE_URL` IS THE SWITCH. Absent, there is no endpoint and the
 * feature does not exist -- the same rule `secrets.ts#getModel` follows for the
 * desktop. What must NOT differ between the two surfaces is what counts as a
 * usable endpoint once one is named: the desktop's `assertUsableModel` argues
 * that case at length, and `modelFromEnv` below applies the same rules through
 * the same functions. It once applied none of them, which let half an endpoint
 * send document text to a paid host.
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
 * ## Every value is checked HERE, and the message names the variable
 *
 * This function used to coerce and hand on, leaving each rule to fire somewhere
 * downstream -- and downstream is too late in three separate ways, all of which
 * a reviewer reproduced:
 *
 * - **`OEQ_MODEL` unset while `OEQ_MODEL_BASE_URL` is set** sent document text
 *   to a hosted endpoint with `"model": ""` in the body, once per row, all
 *   failing, all charged for by whatever a gateway charges for accepting a
 *   request. `--ai`'s own error names `OEQ_MODEL`, and then nothing enforced it.
 *   The desktop refuses exactly this in `secrets.ts#assertUsableModel`; the
 *   store differs between the two surfaces and the RULE must not.
 * - **`OEQ_MODEL_CAP=eight`** made `Number` return `NaN`, and the confirmation
 *   rendered from it: "About to send up to NaN model requests... Your limit is
 *   NaN". That text is the only thing between an operator and a paid batch, and
 *   it was being generated from input the other front end rejects outright.
 *   `assertUsableCap` would have caught it -- after the whole folder was read.
 * - **`OEQ_MODEL_TIMEOUT_SECONDS`** reported from the provider constructor,
 *   after every file had been read, in milliseconds. `timeoutSecondsProblem`
 *   exists precisely because that seam produced "a unit they were not shown and
 *   a number they did not type", and this variable walked straight back into it.
 *
 * NOT A SECOND COPY OF ANY RULE. `assertUsableBudget`, `assertUsableCap` and
 * `timeoutSecondsProblem` are the same functions the settings screen and the
 * fill pass ask; `assertUsableModelPass` constructs the real provider and
 * discards it, so the address check and the plain-http-with-a-key refusal are
 * the ones that would actually have run. All this adds is WHICH VARIABLE was
 * wrong, which is the one thing those rules cannot know.
 *
 * `OEQ_MODEL_BASE_URL` IS STILL THE SWITCH: absent, this returns null and the
 * feature does not exist. Absent is not a misconfiguration and is never an
 * error here -- `runExtract` decides whether `--ai` makes it one.
 */
export function modelFromEnv(env: NodeJS.ProcessEnv): ModelPassSettings | null {
  const baseUrl = env[MODEL_ENV.baseUrl]?.trim();
  if (!baseUrl) return null;

  const model = env[MODEL_ENV.model]?.trim() ?? '';
  if (model === '') {
    throw new ValidationError(
      `${MODEL_ENV.baseUrl} is set but ${MODEL_ENV.model} is empty, so there is no model to ask. ` +
        `Set ${MODEL_ENV.model} to the model's name at that endpoint -- 'llama3' for a local ` +
        `Ollama, 'gpt-4o-mini' for OpenAI. Without it the request goes out naming no model at ` +
        `all, and every row fails after the document has already been sent.`,
    );
  }

  const settings: ModelPassSettings = {
    baseUrl,
    model,
    apiKey: env[MODEL_ENV.key]?.trim() ?? '',
    budget: checkedNumber(env, MODEL_ENV.budget, MODEL_DEFAULTS.budget, assertUsableBudget),
    cap: checkedNumber(env, MODEL_ENV.cap, MODEL_DEFAULTS.cap, assertUsableCap),
    ...timeoutFromEnv(env),
  };

  // LAST, because it is the check that needs the finished object. Constructing
  // the real provider means the address rule and the "a bearer key does not
  // cross plain http" rule are the ones that would have run on the first row --
  // not a copy of them that is free to drift.
  try {
    assertUsableModelPass(settings);
  } catch (cause) {
    throw new ValidationError(
      `${MODEL_ENV.baseUrl} (and ${MODEL_ENV.key}, if set) are not usable together: ` +
        `${(cause as Error).message}`,
      { cause },
    );
  }
  return settings;
}

/**
 * A number from the environment, refused by the project's own rule for it, with
 * the variable named.
 *
 * A blank or unset variable takes the default. Anything else must survive
 * `assert` -- the same function the settings screen and `fillWithModel` call, so
 * there is one answer to what a budget or a cap may be and this only says where
 * a bad one came from.
 */
function checkedNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  assert: (value: number) => void,
): number {
  const text = env[name]?.trim();
  if (text === undefined || text === '') return fallback;
  const value = Number(text);
  try {
    // Catches `NaN` through the shared rule rather than through a check written
    // here: both `assertUsableBudget` and `assertUsableCap` refuse a non-finite
    // number, and a NaN cap is the worst of these -- it compares false against
    // everything, so `used >= cap` never fires and the ceiling the operator
    // agreed to silently does not exist.
    assert(value);
  } catch (cause) {
    throw new ValidationError(`${name} is '${text}'. ${(cause as Error).message}`, { cause });
  }
  return value;
}

/**
 * The time limit, in the unit the variable is named for, or nothing.
 *
 * ASKED AND ANSWERED IN SECONDS. `timeoutSecondsProblem` exists because
 * multiplying by 1000 before checking told an operator their value "must be
 * between 1 and 2147483647" about a number they did not type, in a unit they
 * were never shown. Reaching that seam through an environment variable rather
 * than a text box does not make it better.
 */
function timeoutFromEnv(env: NodeJS.ProcessEnv): { timeoutMs?: number } {
  const text = env[MODEL_ENV.timeoutSeconds]?.trim();
  if (text === undefined || text === '') return {};
  const seconds = Number(text);
  const problem = timeoutSecondsProblem(seconds);
  if (problem !== null) {
    throw new ValidationError(`${MODEL_ENV.timeoutSeconds} is '${text}'. ${problem}`);
  }
  return { timeoutMs: seconds * 1000 };
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

  // `--ai` ON A PROFILE NO MODEL COULD WRITE IS REFUSED, exactly as `--ai` with
  // no endpoint is. Both are an explicit instruction that cannot be carried
  // out, and doing one silently while throwing on the other was an
  // inconsistency with nothing behind it. Silently ignoring a flag somebody
  // typed is how a run "with the model on" quietly turns out not to have been.
  if (options.ai === true && !wantsModel) {
    throw new ValidationError(
      `--ai was given, but no column in this profile asks for a language model, so there is ` +
        `nothing for one to write. Add { "ai": true } to a column's "sources" -- last, after ` +
        `the sources that read the document -- or drop --ai.`,
    );
  }

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
  // Narrowed into a local rather than asserted at the call site: `settings!`
  // told the compiler what the reader had to work out for themselves.
  const sending = wantsModel && !dryRun ? settings : null;

  /**
   * Why the model columns are coming out empty, or null when they are not.
   *
   * A DRY RUN WITH AN ENDPOINT GETS NO PER-CELL NOTE: the line printed below
   * says the model was deliberately not asked, nothing is written to a file
   * anyway, and "no model is configured" would be flatly untrue about a machine
   * that has one.
   */
  const unfilled: MissingModelReason | null =
    !wantsModel || sending !== null ? null
    : dryRun && settings !== null ? null
    : options.ai === true ? 'not-configured'
    : 'not-requested';

  const targets: FillTarget[] = [];
  const collect =
    sending === null
      ? {}
      : { onRow: (row: ExtractedRow, doc: DocumentData) => { targets.push({ row, doc }); } };

  /** Taken once when the operator has to be shown a count, and handed to the
   *  run so both describe the same batch. See `ExtractOptions.listing`. */
  let listing: FolderListing | undefined;

  if (sending !== null) {
    // BEFORE A SINGLE FILE IS READ, so an operator who declines has not paid for
    // anything -- not even the reading. The count comes from `listFolder`, which
    // `extractFolder` calls again below; ONE listing is taken here and handed
    // down, because two walks of the same directory can disagree (a file added
    // or removed in between), and the number the operator agreed to must be the
    // number the run works from rather than a second opinion about it.
    listing = await listFolder(options.dir);
    approve(options, profile, sending, listing.supported.length, log);
  } else if (wantsModel && settings !== null) {
    log(
      // `describeHost`, not the raw address: a gateway's published URL can carry
      // a key in its path or query, and neither belongs on a screen. Every other
      // surface that names an endpoint goes through this helper.
      `Dry run -- no model was asked anything and nothing was sent to ` +
        `${describeHost(settings.baseUrl)}. The columns that would be filled by one are shown ` +
        `empty below. Run without --dry-run to fill them.`,
    );
  }

  const result = await extractFolder(options.dir, profile, { ...collect, ...(listing ? { listing } : {}) });

  if (sending !== null) {
    await runModelPass(targets, profile, sending, fetchImpl);
  } else if (unfilled !== null) {
    // Said per cell, because a silently empty cell is indistinguishable from a
    // document that had nothing to say -- the failure this codebase has shipped
    // four times. WHICH sentence is the other half of getting that right.
    noteMissingModel(result.rows, profile, unfilled);
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
