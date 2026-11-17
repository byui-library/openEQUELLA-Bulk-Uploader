// src/core/extract/length.ts
//
// IMPORTS NOTHING. A leaf module, so the renderer can read the limit later
// without a `node:` import appearing anywhere in its graph.

/**
 * How long a description may be: about 150 words, one or two paragraphs.
 *
 * Chosen by the operator, 2026-11-17, after a batch whose descriptions were
 * 4,000-character passages copied from the middle of a journal's articles. A
 * catalogue description summarises; an extract cut off at an arbitrary length
 * reads as authoritative and is not.
 *
 * Expressed in characters rather than paragraphs on purpose: text extracted
 * from a PDF often has a blank line between every wrapped line, so a
 * paragraph count would throw away real text.
 */
export const DESCRIPTION_LIMIT = 1000;

/** A column's limit: its own, or the default. One rule for the extractor and the model pass. */
export function limitFor(column: { maxLength?: number }): number {
  return column.maxLength ?? DESCRIPTION_LIMIT;
}

/** Shorter than this, a cut-back to a sentence or word end throws too much away. */
const MIN_KEPT = 60;

/** Where a shortened text was cut, so the note can say so truthfully. */
export type CutAt = 'sentence' | 'word' | 'limit';

export interface Shortened {
  text: string;
  /** Null when nothing was removed. */
  cutAt: CutAt | null;
}

/**
 * `text` cut to at most `limit` characters, ending at the last whole sentence
 * that fits -- or the last whole word, when no sentence ends late enough to be
 * worth cutting back to, or at the limit itself when there is no word break.
 *
 * A sentence end is a `.`, `!` or `?` (optionally closing a quotation or
 * bracket) FOLLOWED BY WHITESPACE OR THE END OF THE WHOLE TEXT. The text after
 * the cut decides, not the cut itself: a full stop that happens to land at the
 * limit, inside "2.5", is not a sentence end.
 *
 * For text READ FROM A DOCUMENT only. Generated text is never shortened: a
 * model's reply that runs over is refused whole (core/ai/fill.ts), because a
 * cut-down sentence of generated prose can read as complete while meaning
 * something else. What the operator typed is never shortened either; `plan`
 * warns about it instead.
 */
export function shortenText(text: string, limit: number): Shortened {
  if (text.length <= limit) return { text, cutAt: null };

  let sentenceEnd = -1;
  for (const match of text.matchAll(/[.!?]["')\]]?(?=\s|$)/g)) {
    const end = match.index + match[0].length;
    if (end > limit) break;
    sentenceEnd = end;
  }
  if (sentenceEnd >= MIN_KEPT) return { text: text.slice(0, sentenceEnd).trim(), cutAt: 'sentence' };

  const head = text.slice(0, limit);
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace >= MIN_KEPT) return { text: head.slice(0, lastSpace).trim(), cutAt: 'word' };
  return { text: head.trim(), cutAt: 'limit' };
}
