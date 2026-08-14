// src/core/ai/slice.ts
import { readSection } from '../extract/sections.js';
import { readOpening } from '../extract/opening.js';

export type SliceShape = 'whole' | 'opening+sections' | 'empty';

export interface Slice {
  text: string;
  /** Recorded on the row, so a surprising output can be explained. */
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
 * Shorter than this, a TRUNCATED part is a fragment rather than a passage.
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
 */
function fitToBudget(part: string, limit: number): string {
  if (part.length <= limit) return part;

  const head = part.slice(0, limit);
  const lastSpace = head.lastIndexOf(' ');
  const cut = (lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd();
  return cut.length >= MIN_USEFUL ? cut : '';
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
 * So each part gets an EQUAL SHARE OF WHAT IS LEFT, claimed sections-first,
 * with whatever a short part does not need handed back to the pool. Equal
 * shares bound what any one part can take; claiming in signal order decides who
 * benefits when a part comes in under its share; returning the remainder means
 * nothing is wasted. It is deterministic and needs no constant anyone has to
 * justify.
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
  const trimmed = text.trim();
  if (trimmed === '') return { text: '', shape: 'empty' };
  if (trimmed.length <= options.budget) return { text: trimmed, shape: 'whole' };

  // Assembled in the order the model reads them, which is the order the
  // document has them in.
  const parts: string[] = [];
  const opening = readOpening(trimmed);
  if (opening !== '') parts.push(opening);
  const openingIndex = opening !== '' ? 0 : -1;

  for (const heading of options.sections) {
    const body = readSection(trimmed, heading).text.trim();
    if (body !== '') parts.push(`${heading}\n${body}`);
  }
  if (parts.length === 0) return { text: '', shape: 'empty' };

  // Claimed sections first, opening last: the section is what the operator
  // named, and the opening is the part this tool already treats as a guess.
  const claimOrder = parts.map((_, index) => index).filter((index) => index !== openingIndex);
  if (openingIndex !== -1) claimOrder.push(openingIndex);

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

  const assembled = kept.filter((part) => part !== '').join(SEPARATOR);
  // A budget too small for any part to survive whole leaves nothing to send.
  // Same rule as above: report that, rather than an `opening+sections` holding
  // an empty string.
  if (assembled === '') return { text: '', shape: 'empty' };

  return { text: assembled, shape: 'opening+sections' };
}
