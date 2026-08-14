// src/core/ai/fill.ts
import { describeReason } from '../errorReason.js';
import { ValidationError } from '../errors.js';
import { expectedButEmptyNote } from '../extract/rows.js';
import type { Column, DocumentData, ExtractedRow, Profile, Transform } from '../extract/types.js';
import { eligibleColumns } from './eligible.js';
import { buildPrompt, cleanReply } from './prompt.js';
import { assertUsableBudget, sliceForModel, type SliceShape } from './slice.js';

/**
 * Just enough of a provider to be substitutable in a test.
 *
 * ## AN IMPLEMENTER'S OBLIGATION: EVERY MESSAGE THIS THROWS IS ALREADY REDACTED
 *
 * Not a note about `OpenAiCompatibleProvider` -- a condition of implementing
 * this interface, stated here because this is the file a second adapter's
 * author reads. **`fill.ts` writes the reason for a failed call straight into a
 * spreadsheet note**, and a spreadsheet is a file operators email around asking
 * for help. An API key that reaches one is a key disclosed.
 *
 * It covers the WHOLE CAUSE CHAIN, not the top message. `describeReason` walks
 * `cause` -- it has to, because Node's own `fetch` throws `TypeError: fetch
 * failed` and hides the useful half underneath -- so an adapter that writes the
 * ordinary `new Error(message, { cause: rawFetchError })` hands an unredacted
 * chain to a note. `OpenAiCompatibleProvider` meets this by redacting BEFORE
 * truncating (the other order leaves a matchable fragment and lets a prefix
 * walk out) and by deliberately attaching no `cause` at all, since redaction
 * cannot reach inside an object it did not build. An adapter that needs a cause
 * must build one it has redacted itself.
 *
 * The second condition is smaller and in the same spirit: a failure throws,
 * always, and never returns an empty string. A caller that cannot tell "the
 * model said nothing" from "the call failed" writes a blank and calls it
 * success -- the exact shape of failure this codebase has shipped repeatedly.
 */
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
 * Refuse a run cap nothing sensible can be counted against.
 *
 * A NaN cap is the worse of the two configuration faults this pass can carry:
 * it compares false against everything, so `used >= cap` never fires, the
 * ceiling the operator agreed to silently does not exist, and every row in the
 * batch is sent to a paid endpoint.
 *
 * EXPORTED SO THE SETTINGS STORE CAN ASK BEFORE ANYTHING IS SAVED, for the same
 * reason `assertUsableBudget` is (see slice.ts). A mistyped box should be
 * refused on the screen where it was typed, not four hundred rows into a run --
 * and the two answers cannot disagree if there is only one of them. A second
 * copy on the way in is free to drift from the one that actually runs, which
 * would let the settings screen accept a value the run then refuses.
 *
 * ZERO IS ALLOWED, and is not the same as a mistake: it means "make no requests
 * at all", every row says it was stopped by the limit, and nothing is spent.
 */
export function assertUsableCap(cap: number): void {
  if (!Number.isFinite(cap) || cap < 0) {
    throw new ValidationError(
      `The model run limit must be zero or a positive number, but it was '${String(cap)}'. ` +
        `It is the most requests one run may make; nothing beyond it is sent, and every row it stops says so.`,
    );
  }
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

/** Most of a discarded reply to quote back, in code points. Enough to recognise
 *  a refusal or a stray preamble; not enough to paste a generated paragraph
 *  into a cell somebody has to read. */
const MAX_QUOTED_REPLY = 80;

/**
 * Text safe to put in one spreadsheet cell.
 *
 * APPLIED TO EVERY UNTRUSTED STRING THIS MODULE WRITES, and the reason is
 * sharper for the error path than for the model's reply: `describeReason`
 * returns up to 200 characters that may have come from a SERVER'S RESPONSE
 * BODY, so it is the one carrying text nobody here chose. A newline in it ends
 * the note visually; a control character can be invisible in the cell and
 * present in the file.
 *
 * `\s` alone is not enough -- it misses the C0 controls a truncated or binary
 * response is full of -- so the class covers `\p{Cc}` and `\p{Cf}` too, which
 * needs the `u` flag.
 */
function flatten(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
}

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
 * THE TRANSFORM ARM IS EXHAUSTIVE ON PURPOSE. Written as a catch-all --
 * `transform !== undefined ? 'date'` -- a `transform: 'uppercase'` added later
 * would make every such column announce "this column holds a date. An invented
 * date cannot be told from a real one", which is a false statement inside the
 * one note whose entire job is to say which kind of field it was. `rows.ts` has
 * the loud version of this already: it narrows the same way and then reads
 * `.date`, so a new member breaks the typecheck there. This does the same with
 * a `never` assignment.
 *
 * WHAT IT MISSES, AND THIS IS NOT SMALL:
 *
 * - **Fact fields that declare nothing.** An identifier, a place name, a term
 *   from a controlled vocabulary, a person's name recorded as plain text. All
 *   are fact fields by the spec's definition -- "dates, names, identifiers,
 *   anything from a controlled vocabulary" -- and none of them declares
 *   anything this function can read, so each gets the prose wording.
 * - **Future date-shaped sources.** The `dateNear`/`datePair` arm is a literal
 *   list with no typecheck behind it, because `Source` is a union of object
 *   shapes rather than a tagged enum. A `{ dateRange: ... }` added later is
 *   silently prose, and nothing fails to tell anyone.
 *
 * The failure is in the safe direction -- every model-written cell is flagged
 * regardless; a fact field is merely flagged less loudly -- and the alternative
 * was a list of xpath substrings such as `identifier`, which is guessing at an
 * institution's schema, the assumption an entire release was spent removing. If
 * this must be closed, close it by giving the profile something honest to
 * declare, not by pattern matching on somebody else's field names.
 */
function factKind(column: Column): 'date' | 'name' | null {
  const fromTransform = (transform: Transform): 'date' | 'name' => {
    if (transform === 'people') return 'name';
    if (transform === 'date') return 'date';
    if (typeof transform === 'object' && 'date' in transform) return 'date';
    // Unreachable while `Transform` holds only the members above; a new one
    // stops the build here rather than being announced to an operator as a
    // date. Named so the compiler's message says what to do.
    const everyTransformIsClassified: never = transform;
    return everyTransformIsClassified;
  };

  if (column.transform !== undefined) return fromTransform(column.transform);
  if (column.sources.some((s) => 'dateNear' in s || 'datePair' in s)) return 'date';
  return null;
}

/**
 * The note left on a cell the model wrote.
 *
 * EVERY WRITE IS FLAGGED, without exception -- a model output is a guess, and
 * this tool's rule is that a guess says so. A fact field says more than that,
 * because the two are not the same risk and a reviewer skimming four hundred
 * notes needs the difference visible on the line.
 *
 * `${path}: ` is the pipeline's own prefix, from `rows.ts#fill`. One grammar
 * for every per-column note, so the column can be found the same way in all of
 * them.
 */
function writtenNote(column: Column, path: string): string {
  const kind = factKind(column);
  if (kind === null) {
    return `${path}: written by a language model from the document text -- please check it before uploading.`;
  }
  return (
    `${path}: written by a language model from the document text, and this column holds a ${kind}. ` +
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
 * TRUNCATED, AND SAFE TO SHOW. It goes into `_notes`, which `plan.ts` drops
 * with every other annotation column before anything is uploaded, so a refusal
 * quoted here cannot reach a catalogue record the way one written into the cell
 * would. Cut BY CODE POINT: cutting a UTF-16 string at 80 units can split a
 * surrogate pair and leave a lone half, which is not a character and does not
 * survive a round trip through a spreadsheet.
 */
function quoted(discarded: string): string {
  const flat = flatten(discarded);
  if (flat === '') return '';
  const points = [...flat];
  const shown =
    points.length > MAX_QUOTED_REPLY
      ? `${points.slice(0, MAX_QUOTED_REPLY).join('')}...`
      : flat;
  return ` What it said, which was not used: "${shown}"`;
}

/**
 * Fill eligible cells from a language model. Mutates the rows in place, the way
 * the rest of the extract pipeline already works.
 *
 * ONE CALL PER ELIGIBLE CELL, IN ORDER, AND NEVER A RETRY. A retry loop over a
 * paid endpoint is a bill nobody agreed to, and the operator has already been
 * shown a count and confirmed it. A failure leaves the cell as it found it,
 * with the reason on the row.
 *
 * EVERY WRITE IS FLAGGED. A model output is a guess, and this tool's rule is
 * that a guess says so -- the same rule that flags an opening paragraph.
 *
 * NOTHING IS EVER WRITTEN EXCEPT AN `ok` REPLY. A refusal, a preamble with
 * nothing under it, an empty answer and a failed call all leave the cell
 * exactly as they found it and say what happened. `cleanReply` carries no
 * `text` on a failure precisely so this cannot be got wrong by accident.
 *
 * RUNNING IT TWICE OVER THE SAME ROWS SENDS NOTHING THE SECOND TIME. A written
 * cell is no longer eligible, because the write clears the flag that made it
 * eligible and records itself in `aiWritten` instead. Without that, a second
 * pass re-sends and re-charges for every cell the first one wrote, and
 * overwrites the model's own earlier answer with a different one.
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
  assertUsableCap(options.cap);

  let used = 0;

  for (const { row, doc } of targets) {
    const eligible = new Set(eligibleColumns(profile, row));
    // Before the document is touched at all: a row with nothing to fill must
    // not pay to read, slice or measure a file nobody is going to send.
    if (eligible.size === 0) continue;

    // SLICED ONCE PER ROW, not once per eligible column. The slice depends on
    // the document alone, so computing it per column repeats the whole of
    // `slice.ts` -- two section scans and a two-pass budget division -- to
    // produce the identical string, once per enabled field on every row in the
    // batch. Nothing asserts the count, deliberately: reads of `doc.text` are
    // not the same thing as calls to `sliceForModel`, and a test that watched
    // them would pass a mutation that sliced per column while failing a
    // harmless inlining. What IS asserted is that both columns are sent the
    // same document.
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
      for (const path of eligible) row.notes.push(`${path}: not sent to the model -- ${why}`);
      // No call was made, so no cap was spent. A row that could not be sent
      // must not consume the ceiling a row that can be sent needs.
      continue;
    }

    // Over the COLUMNS rather than the paths, so the column each path belongs
    // to needs no lookup. The lookup it replaces could not fail -- every path
    // came from `profile.columns` -- but its `undefined` branch had to do
    // something, and every option was wrong: skipping silently leaves a cell
    // with neither a value nor a note, which is the one failure mode this
    // module is otherwise careful about.
    for (const column of profile.columns) {
      if (!eligible.has(column.path)) continue;
      const path = column.path;

      if (used >= options.cap) {
        row.notes.push(
          `${path}: not sent to the model -- this run reached its limit of ${options.cap} model requests.`,
        );
        continue;
      }
      // Counted before the call, not after it: a call that throws still cost
      // whatever the endpoint charged for accepting it.
      used += 1;

      // WHICH FAILURE SENTENCE IS TRUE DEPENDS ON WHAT IS IN THE CELL. The
      // eligible set is "empty OR flagged", so on the design's headline case --
      // tier 3 produced a flagged opening paragraph and the model was invited
      // to improve on it -- the cell still holds that paragraph. Keeping it is
      // right; blanking it would destroy evidence the design says may only be
      // replaced by something better. But "was left blank" is then false: an
      // operator filtering `_notes` for it gets rows that are not blank, and
      // one skimming reads a populated description as absent.
      const outcome = (row.cells[path] ?? '').trim() === '' ? 'left blank' : 'not replaced';

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
        // The reason is read through the cause chain because Node's own fetch
        // throws `TypeError: fetch failed` and hides the useful half beneath it
        // -- a wrong address, a stopped model and an expired certificate
        // otherwise all arrive as the same two useless words. Putting it in a
        // note is only safe because of the redaction obligation on
        // `Completer`; read that before writing a second adapter.
        row.notes.push(
          `${path}: ${outcome} -- ${flatten(describeReason(error))}${sentClause(slice.shape)}`,
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
          `${path}: ${outcome} -- ${cleaned.reason}.` +
            `${quoted(cleaned.discarded)}${sentClause(slice.shape)}`,
        );
        continue;
      }

      const note = `${writtenNote(column, path)}${sentClause(slice.shape)}`;
      row.cells[path] = cleaned.text;
      row.sources[path] = AI_SOURCE;
      row.notes.push(note);
      // The structural record. See `aiWritten` in types.ts: it is what lets a
      // counter separate "a model wrote here, as designed" from "this row has a
      // problem", and what stops a second pass paying for this cell again.
      row.aiWritten[path] = note;
      // The source's doubt has been acted on. Leaving it would keep the cell
      // eligible for ever, and the note it holds describes a value that is no
      // longer in the cell.
      delete row.flagged[path];
      // "Fill that cell in by hand" is now false -- the cell has content, and
      // the note just pushed already asks for it to be checked. Removed by the
      // string `rows.ts` itself produces rather than by matching a prefix, so
      // changing the wording cannot silently strand it.
      if (column.flagIfEmpty === true) {
        const stale = row.notes.indexOf(expectedButEmptyNote(path));
        if (stale !== -1) row.notes.splice(stale, 1);
      }
    }
  }
}

/**
 * The field, in words, for the prompt. `MWDL/deathDate` -> "a death date".
 *
 * The leaf only: a schema xpath is a path to a value and the last segment is
 * what the value is. Separators become spaces and camel case is split, because
 * "a deathdate" is not a phrase in the language the model is answering in.
 *
 * THE ARTICLE IS CHOSEN, not fixed at "a". `a abstract` in the first line of a
 * prompt is a small thing that says the tool is careless, to a reader who is
 * being asked to be careful.
 *
 * A COUPLING WORTH KNOWING: `prompt.ts`'s preamble stripper only recognises a
 * model announcing a `description`, `summary`, `answer` or `response`. A field
 * whose leaf is none of those -- `abstract`, `coverage` -- can still draw
 * "Here is the abstract:" and it will not be stripped. That is deliberate on
 * that side (an unusual preamble surviving is the accepted cost, a first line
 * wrongly removed is not) and is recorded here because this function is where
 * the vocabulary is decided.
 */
function describeField(path: string): string {
  const leaf = path.split('/').pop() ?? path;
  const words = leaf
    .replace(/[_-]+/g, ' ')
    // deathDate -> death Date, and ISBNNumber -> ISBN Number.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return `${/^[aeiou]/.test(words) ? 'an' : 'a'} ${words}`;
}
