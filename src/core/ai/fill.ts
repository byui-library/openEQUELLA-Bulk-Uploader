// src/core/ai/fill.ts
import { describeReason } from '../errorReason.js';
import { ValidationError } from '../errors.js';
import type { Column, DocumentData, ExtractedRow, Profile } from '../extract/types.js';
import { eligibleColumns } from './eligible.js';
import { buildPrompt, cleanReply } from './prompt.js';
import { assertUsableBudget, sliceForModel, type SliceShape } from './slice.js';

/** Just enough of a provider to be substitutable in a test. */
export interface Completer {
  complete(prompt: string): Promise<string>;
}

export interface FillOptions {
  /** Characters of document to send. See `slice.ts`. */
  budget: number;
  /** Section headings to prefer when the whole document will not fit. */
  sections: string[];
  /**
   * Most REQUESTS to make in one run. Reaching it is reported, never silent.
   *
   * Requests, not rows: a row with two enabled columns is two calls and two
   * lots of spend, and counting rows would let a cap of 500 make a thousand
   * calls. With one column enabled -- what ships -- the two numbers are the
   * same, which is why the confirmation dialog can go on saying "documents".
   */
  cap: number;
  /** House style, from the profile. */
  instruction?: string | null;
}

export interface FillTarget {
  row: ExtractedRow;
  doc: DocumentData;
}

/**
 * What is written into `_source` for a cell a model wrote.
 *
 * SET HERE RATHER THAN THROUGH `rows.ts#sourceKind`, which has no `ai` case and
 * would fall through to `properties` -- naming an embedded document property as
 * the origin of something no document contains. That function is unreachable
 * from this pass by design: `resolve` returns empty for an `ai` source and
 * never records a kind for it, so the marker has exactly one home and this is
 * it.
 */
const AI_SOURCE = 'ai';

/** Most of a discarded reply to quote back. Enough to recognise a refusal or a
 *  stray preamble; not enough to paste a generated paragraph into a cell
 *  somebody has to read. */
const MAX_QUOTED_REPLY = 80;

/**
 * Which kind of value a column holds, where the profile says so.
 *
 * THE SPEC REQUIRES THE FLAG TO SAY WHICH KIND OF FIELD IT WAS. "A description
 * that reads oddly is a quality problem a cataloguer can fix. A fabricated
 * death date is indistinguishable from a real one to everyone downstream,
 * permanently", in a collection with no moderation queue.
 *
 * DERIVED FROM THE PROFILE, NEVER A NEW SETTING. A per-column `factField` flag
 * would be one more thing to set correctly, wrong by default on every profile
 * written before it existed, and free to drift out of step with the column it
 * describes. Two things a column already declares say this without being asked:
 * a `transform`, which exists precisely because the value is a date or a list
 * of people; and a `dateNear`/`datePair` source, which is a column asking for a
 * date whether or not it also declared a transform -- the shipped obituary
 * template's death-date column is sourced exactly that way.
 *
 * WHAT IT MISSES, AND THIS IS NOT SMALL: an identifier, a place name, a term
 * from a controlled vocabulary, a person's name recorded as plain text. All are
 * fact fields by the spec's definition -- "dates, names, identifiers, anything
 * from a controlled vocabulary" -- and none of them declares anything this
 * function can read, so each gets the prose wording. The failure is in the safe
 * direction (every model-written cell is flagged regardless; a fact field is
 * merely flagged less loudly), and the alternative was a list of xpath
 * substrings such as `identifier`, which is guessing at an institution's schema
 * -- the assumption an entire release was spent removing. If it must be closed,
 * close it by giving the profile something honest to declare, not by pattern
 * matching on somebody else's field names.
 */
function factKind(column: Column): 'date' | 'name' | null {
  if (column.transform === 'people') return 'name';
  if (column.transform !== undefined) return 'date';
  if (column.sources.some((s) => 'dateNear' in s || 'datePair' in s)) return 'date';
  return null;
}

/**
 * The note left on a cell the model wrote.
 *
 * EVERY WRITE IS FLAGGED, without exception -- a model output is a guess, and
 * this tool's rule is that a guess says so. A fact field says more than that,
 * because the two are not the same risk and a reviewer skimming four hundred
 * identical notes needs the difference to be visible on the line.
 */
function writtenNote(column: Column, path: string): string {
  const kind = factKind(column);
  if (kind === null) {
    return `${path} was written by a language model from the document text -- please check it before uploading.`;
  }
  return (
    `${path} was written by a language model from the document text, and this column holds a ${kind}. ` +
    `An invented ${kind} cannot be told from a real one by anyone reading the catalogue afterwards, ` +
    `so check it against the document before uploading.`
  );
}

/**
 * One clause saying the model did not see the whole file, or nothing.
 *
 * ONE CLAUSE ON THE EXISTING NOTE, never a second note per cell: a batch of 400
 * rows carrying two notes each is a wall nobody reads, and the first thing to
 * be skipped in a wall is the flag that matters. Added to a failure note as
 * well as to a write -- a refusal from a model that saw a fifth of the document
 * is exactly the surprising output the recorded shape exists to explain.
 */
function sentClause(shape: SliceShape): string {
  return shape === 'whole'
    ? ''
    : ' Only part of the document was sent: its opening and any named sections, not all of it.';
}

/**
 * A reply the cleaner threw away, quoted back, or nothing.
 *
 * THE MODEL SPOKE AND THIS TOOL BINNED IT. A note saying only "the model
 * declined" is true; a note that leaves the operator unable to see there was an
 * answer at all is the same misreport this codebase keeps shipping, wearing its
 * other face. Both discards -- the refusal pattern and the preamble pattern --
 * are heuristics their own docblocks admit can be wrong, so the operator is
 * given enough of the reply to judge whether the cleaner was right.
 *
 * TRUNCATED, AND SAFE TO SHOW. It goes into `_notes`, which `schema.ts` treats
 * as an annotation column and never uploads, so a refusal quoted here cannot
 * reach a catalogue record the way one written into the cell would. Whitespace
 * is collapsed because this ends up in one spreadsheet cell.
 */
function quoted(discarded: string): string {
  const flat = discarded.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const shown = flat.length > MAX_QUOTED_REPLY ? `${flat.slice(0, MAX_QUOTED_REPLY)}...` : flat;
  return ` What it said, which was not used: "${shown}"`;
}

/**
 * Fill eligible cells from a language model. Mutates the rows in place, the way
 * the rest of the extract pipeline already works.
 *
 * ONE CALL PER ELIGIBLE CELL, IN ORDER, AND NEVER A RETRY. A retry loop over a
 * paid endpoint is a bill nobody agreed to, and the operator has already been
 * shown a count and confirmed it. A failure leaves the cell blank with the
 * reason on the row.
 *
 * EVERY WRITE IS FLAGGED. A model output is a guess, and this tool's rule is
 * that a guess says so -- the same rule that flags an opening paragraph.
 *
 * NOTHING IS EVER WRITTEN EXCEPT AN `ok` REPLY. A refusal, a preamble with
 * nothing under it, an empty answer and a failed call all leave the cell
 * exactly as they found it and say what happened. `cleanReply` carries no
 * `text` on a failure precisely so this cannot be got wrong by accident.
 */
export async function fillWithModel(
  targets: FillTarget[],
  profile: Profile,
  provider: Completer,
  options: FillOptions,
): Promise<void> {
  // BEFORE THE LOOP, BOTH OF THEM. A mistyped budget or cap is a configuration
  // fault affecting every row identically, and a run that discovers it per row
  // produces four hundred notes about a single text box -- after spending
  // nothing, while looking like it tried. A NaN cap is the worse of the two: it
  // compares false against everything, so the ceiling the operator agreed to
  // silently does not exist and every row is sent.
  assertUsableBudget(options.budget);
  if (!Number.isFinite(options.cap) || options.cap < 0) {
    throw new ValidationError(
      `The model run limit must be zero or a positive number, but it was '${String(options.cap)}'. ` +
        `It is the most requests one run may make; nothing beyond it is sent, and every row it stops says so.`,
    );
  }

  const columns = new Map(profile.columns.map((column) => [column.path, column]));
  let used = 0;

  for (const { row, doc } of targets) {
    const paths = eligibleColumns(profile, row);
    // Before the document is touched at all: a row with nothing to fill must
    // not pay to read, slice or measure a file nobody is going to send.
    if (paths.length === 0) continue;

    // READ ONCE, SLICE ONCE. The slice depends on the document alone, so
    // computing it per eligible column repeats the whole of `slice.ts` -- two
    // section scans and a two-pass budget division -- to produce the identical
    // string, once per enabled field on every row in the batch.
    const text = doc.text;
    const slice = sliceForModel(text, { budget: options.budget, sections: options.sections });

    if (slice.shape === 'empty') {
      // The one cause that is knowable, told apart from the two that are not.
      // See `SliceShape`: an empty slice also arises from a document with no
      // opening and no named section, and from a budget too small for any part
      // to survive -- and sending the operator to the file when the fault is a
      // setting is the same wrong-cause defect in a new place.
      const why =
        text.trim() === ''
          ? 'this file has no text to read.'
          : `nothing could be selected to send within the character budget of ${options.budget}. ` +
            `Raising the budget may fix it; the document may also have no opening paragraph and ` +
            `none of the named sections.`;
      for (const path of paths) row.notes.push(`${path} was not sent to the model: ${why}`);
      // No call was made, so no cap was spent. A row that could not be sent
      // must not consume the ceiling a row that can be sent needs.
      continue;
    }

    for (const path of paths) {
      const column = columns.get(path);
      if (column === undefined) continue;

      if (used >= options.cap) {
        row.notes.push(
          `${path} was not sent to the model: this run reached its limit of ${options.cap} model requests.`,
        );
        continue;
      }
      // Counted before the call, not after it: a call that throws still cost
      // whatever the endpoint charged for accepting it.
      used += 1;

      let reply: string;
      try {
        reply = await provider.complete(
          buildPrompt({
            field: describeField(path),
            document: slice.text,
            instruction: options.instruction ?? null,
          }),
        );
      } catch (error) {
        // REDACTION IS THE PROVIDER'S INVARIANT, AND IT IS STATED HERE SO A
        // SECOND ADAPTER INHERITS IT VISIBLY. `provider.ts` guarantees every
        // message it throws has already been through `redactSecret`, so this
        // line may put one in a spreadsheet note. Nothing else may: an error
        // from anywhere but the provider carries no such promise, and an API
        // key written into `_notes` is a key emailed around with the sheet.
        //
        // The reason is read through the cause chain because Node's own fetch
        // throws `TypeError: fetch failed` and hides the useful half beneath
        // it -- a wrong address, a stopped model and an expired certificate
        // otherwise all arrive as the same two useless words.
        row.notes.push(
          `${path} was left blank: ${describeReason(error)}${sentClause(slice.shape)}`,
        );
        continue;
      }

      const cleaned = cleanReply(reply);
      if (cleaned.outcome !== 'ok') {
        // THREE DIFFERENT EVENTS, THREE DIFFERENT SENTENCES. "The model gave no
        // answer" is false for two of them: it answered, and this tool
        // discarded what it said. `cleanReply` writes the clause; repeating the
        // judgement here would be a second place for it to drift.
        row.notes.push(
          `${path} was left blank: ${cleaned.reason}.` +
            `${quoted(cleaned.discarded)}${sentClause(slice.shape)}`,
        );
        continue;
      }

      row.cells[path] = cleaned.text;
      row.sources[path] = AI_SOURCE;
      row.notes.push(`${writtenNote(column, path)}${sentClause(slice.shape)}`);
    }
  }
}

/** The field, in words, for the prompt. `MWDL/description` -> "a description". */
function describeField(path: string): string {
  const leaf = path.split('/').pop() ?? path;
  return `a ${leaf.replace(/[_-]+/g, ' ').toLowerCase()}`;
}
