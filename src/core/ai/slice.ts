// src/core/ai/slice.ts
import { ValidationError } from '../errors.js';
import { readSection } from '../extract/sections.js';
import { readOpening } from '../extract/opening.js';

/**
 * How much of the document went.
 *
 * `empty` MEANS THREE DIFFERENT THINGS AND CANNOT TELL THEM APART: a document
 * with no text at all, a document whose text yielded no opening and matched no
 * named section, and a budget too small for any part to survive `MIN_USEFUL`.
 * Only the first is knowable from outside, by asking the document -- which
 * `fill.ts` does, and it says "no text to read" for that case alone. For the
 * other two it names both possibilities rather than picking one, because a step
 * that reports a cause it cannot know is this codebase's oldest defect and the
 * fix is not to move it somewhere new. Splitting `empty` into two shapes was
 * considered and refused: the operator's action is the same for both -- raise
 * the budget, or look at the document -- so the distinction would cost a member
 * of this union and buy a sentence nobody acts on differently.
 */
export type SliceShape = 'whole' | 'opening+sections' | 'empty';

export interface Slice {
  text: string;
  /** Recorded by `fill.ts` as a clause on the note for every cell it touched,
   *  so a thin or surprising output can be explained from the spreadsheet
   *  rather than blamed on the model. */
  shape: SliceShape;
}

export interface SliceOptions {
  /** Characters. See the spec: a budget the operator sets, not a model lookup. */
  budget: number;
  /** Section headings to prefer when the whole document will not fit. */
  sections: string[];
}

/** What separates one part from the next in the assembled text. */
const SEPARATOR = '\n\n';

/**
 * Refuse a budget nothing can be sliced to.
 *
 * The budget reaches here from an operator's text box. Left to propagate, NaN
 * makes every length comparison false and every slice empty, so the whole batch
 * comes back `empty` and the fill pass reports "no text to read" on files that
 * are full of text -- a false cause, pointing nowhere near the mistyped field.
 * Refused at the door instead.
 *
 * EXPORTED SO THE FILL PASS CAN ASK BEFORE ITS LOOP, not because two callers
 * wanted the same three lines. A mistyped budget is a CONFIGURATION fault
 * affecting every row equally, and discovering it one row at a time produces
 * four hundred identical notes after a run that spent nothing and looks like it
 * tried. Sharing the guard rather than copying it is what stops the two answers
 * drifting apart, which is the other half of the same argument.
 */
export function assertUsableBudget(budget: number): void {
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new ValidationError(
      `The model character budget must be a positive number, but it was '${String(budget)}'. ` +
        `Set it to the most text to send from one document -- a few thousand characters for a local model.`,
    );
  }
}

/**
 * Shorter than this, a TRUNCATED part is a fragment rather than a passage.
 *
 * `opening.ts` already fixes the length below which this codebase refuses to
 * call a block prose at all -- `MIN_PROSE = 60` -- and a fragment shorter than
 * that cannot carry a fact whatever it is cut from. This is that floor plus
 * room for the heading line a section part carries in front of its body
 * (`Executive Summary\n` is 18 characters), so a section is judged on its body
 * rather than on its title.
 *
 * Applies only to truncation. A section that is genuinely two lines long is
 * included whole -- it is short because the document is, not because the
 * budget cut it -- and dropping it would throw away the one thing the operator
 * named a heading to find.
 */
const MIN_USEFUL = 80;

/**
 * `part` cut to `limit` characters at a word boundary, or empty if that leaves
 * a fragment.
 *
 * A part cut mid-word arrives at the model as damaged text, and damaged text is
 * where invention starts: a model handed "he died on 6 Janu" has to decide what
 * the rest said. Better to send less and have it be whole.
 *
 * WHERE THERE IS NO USABLE BOUNDARY, CUT HARD. A run with no spaces in it, or
 * one space near the front, is not words -- it is an OCR run, a base64 blob or
 * a long identifier -- so there is no word to break, and cutting to that one
 * early space would return three characters and then discard them for being a
 * fragment. `sections.ts` had exactly that bug, and it collapsed a
 * 4,000-character section to a single letter.
 */
function fitToBudget(part: string, limit: number): string {
  if (part.length <= limit) return part;

  const head = part.slice(0, limit);
  const lastSpace = head.lastIndexOf(' ');
  const atBoundary = (lastSpace > 0 ? head.slice(0, lastSpace) : '').trimEnd();
  if (atBoundary.length >= MIN_USEFUL) return atBoundary;

  const hard = head.trimEnd();
  return hard.length >= MIN_USEFUL ? hard : '';
}

/**
 * How much of a document to send.
 *
 * WHOLE IF IT FITS, because a one-page obituary states its death date wherever
 * the sentence happens to fall, and leading-N-characters would throw the end
 * away. Beyond the budget, the opening plus any named sections: a property of
 * prose generally -- a thesis, a report, a grant application all say what they
 * are near the front or under a heading -- not of any one document type.
 *
 * ## Why the budget is divided rather than applied at the end
 *
 * Joining the parts and taking the leading `budget` characters -- the obvious
 * implementation, and the one this file was first written with -- lets the
 * OPENING STARVE THE SECTIONS. The opening is emitted first and can be a
 * thousand characters on its own, so with a budget a local model can manage it
 * consumes the lot and the named section never reaches the model at all. That
 * happens precisely when the document is long, which is when the section
 * matters most: the operator named that heading because it is where the answer
 * lives, and the opening is the tier this tool already flags as a guess.
 *
 * So the budget is divided in TWO PASSES.
 *
 * **Pass one gives every part an equal share of what is left, claimed
 * lowest-signal first.** An equal share is a CEILING: `floor(remaining / parts
 * still to claim)`, so claiming early is a restriction and not an advantage,
 * and a part that wants less than its share hands the rest back. Claiming order
 * therefore decides one thing only -- who is sacrificed when the budget is too
 * tight for everyone, because the earliest claimant faces the smallest share
 * and is the first to fall under `MIN_USEFUL`. That must be the opening, the
 * part this tool already flags as a guess, so the opening claims first and a
 * section the operator named claims after it.
 *
 * **Pass two hands the leftover to the parts that were cut short,
 * highest-signal first.** Without it, pass one's ceiling becomes a floor: a
 * 49-character section beside an 845-character opening leaves the opening cut
 * at its equal share and a quarter of the budget unspent, which for the local
 * models this feature exists to serve is document the operator paid for and did
 * not send. This is the pass where being early IS the advantage, so the order
 * is reversed.
 *
 * Both passes are single and fixed-order, so the result is deterministic.
 *
 * Rejected:
 *
 * - **A fixed proportional split** (say 40% opening, 60% sections). Wastes
 *   budget whenever one side is short, and the ratio is a number nobody can
 *   defend.
 * - **Sections only, once the document is long.** Most documents have no
 *   headings at all, and for those the opening is the only part there is.
 * - **Sections take all they need, the opening gets the remainder.** One
 *   section that ran to `readSection`'s 4,000-character cap would swallow a
 *   small model's whole budget and silently drop the opening.
 *
 * NOTHING TO SEND IS REPORTED AS `empty`, not as an `opening+sections` holding
 * an empty string. A document of tables and headings has no opening prose and
 * may match no heading; saying it was sent as opening-plus-sections would be
 * this codebase's oldest failure -- a step that could not run, reported as
 * though it had -- and would hand the model a prompt with no document under it.
 */
export function sliceForModel(text: string, options: SliceOptions): Slice {
  assertUsableBudget(options.budget);

  const trimmed = text.trim();
  if (trimmed === '') return { text: '', shape: 'empty' };
  if (trimmed.length <= options.budget) return { text: trimmed, shape: 'whole' };

  // Assembled in the order the model reads them, which is the order the
  // document has them in.
  const parts: string[] = [];
  const opening = readOpening(trimmed);
  let openingIndex = -1;
  if (opening !== '') {
    parts.push(opening);
    // Derived, not assumed to be 0: correct only by accident if anything is
    // ever pushed ahead of the opening.
    openingIndex = parts.length - 1;
  }

  for (const heading of options.sections) {
    const body = readSection(trimmed, heading).text.trim();
    if (body === '') continue;
    // A section the opening already contains costs the budget twice and sends
    // the model the same sentences instead of more document. `readOpening`
    // returns the first prose LINE, and a PDF's extracted text is often one
    // enormous line holding the abstract too -- which is the shape of every one
    // of the twelve real articles in CLAUDE.md, none of which has `Abstract` at
    // a line start.
    if (opening.includes(body)) continue;
    parts.push(`${heading}\n${body}`);
  }
  if (parts.length === 0) return { text: '', shape: 'empty' };

  // Lowest signal claims FIRST, because the earliest claimant faces the
  // smallest share and is the first to be dropped as a fragment. See the
  // two-pass explanation above -- claiming early is a ceiling, not a privilege.
  const bySignal = parts.map((_, index) => index).filter((index) => index !== openingIndex);
  const claimOrder = openingIndex === -1 ? [...bySignal] : [openingIndex, ...bySignal];

  // The separators are reserved up front rather than accounted for as parts are
  // kept, so the total cannot exceed the budget however many parts survive.
  let remaining = Math.max(0, options.budget - SEPARATOR.length * (parts.length - 1));
  let unclaimed = claimOrder.length;

  const kept = parts.map(() => '');
  for (const index of claimOrder) {
    const share = Math.floor(remaining / unclaimed);
    unclaimed -= 1;
    const fitted = fitToBudget(parts[index]!, share);
    kept[index] = fitted;
    remaining -= fitted.length;
  }

  // Pass two: the leftover goes to the parts pass one cut short, highest signal
  // first -- the named sections, then the opening.
  for (const index of [...bySignal, ...(openingIndex === -1 ? [] : [openingIndex])]) {
    if (remaining <= 0) break;
    const part = parts[index]!;
    const already = kept[index]!;
    if (already.length === part.length) continue;
    const grown = fitToBudget(part, already.length + remaining);
    remaining -= grown.length - already.length;
    kept[index] = grown;
  }

  const assembled = kept.filter((part) => part !== '').join(SEPARATOR);
  // A budget too small for any part to survive whole leaves nothing to send.
  // Same rule as above: report that, rather than an `opening+sections` holding
  // an empty string.
  if (assembled === '') return { text: '', shape: 'empty' };

  return { text: assembled, shape: 'opening+sections' };
}
