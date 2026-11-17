// src/core/extract/length.ts
//
// IMPORTS NOTHING. The columns screen reads the limit from the sandboxed
// renderer, and a leaf module cannot grow a `node:` import later.

/**
 * How long text read from inside a document may be, unless a column says
 * otherwise (`Column.maxLength`). About 150 words: one or two paragraphs.
 *
 * Chosen by the operator, 2026-11-17, after a batch whose descriptions were
 * 4,000-character passages copied from the middle of a journal's articles. A
 * catalogue description summarises; an extract cut off at an arbitrary length
 * reads as authoritative and is not.
 */
export const DESCRIPTION_LIMIT = 1000;

/** A column's limit: its own, or the default. One rule for the extractor and the model pass. */
export function limitFor(column: { maxLength?: number }): number {
  return column.maxLength ?? DESCRIPTION_LIMIT;
}

/** How many paragraphs a shortened text keeps at most. */
const MAX_PARAGRAPHS = 2;

/** Shorter than this, a cut-back to a sentence end throws too much away. */
const MIN_KEPT = 60;

export interface Shortened {
  text: string;
  /** True when anything was removed. The caller notes it on the row. */
  shortened: boolean;
}

/**
 * `text` cut to at most `limit` characters and two paragraphs, ending at the
 * last whole sentence that fits -- or the last whole word, when no sentence
 * ends late enough to be worth cutting back to.
 *
 * For text READ FROM A DOCUMENT only. Generated text is never shortened: a
 * model's reply that runs over is refused whole (core/ai/fill.ts), because a
 * cut-down sentence of generated prose can read as complete while meaning
 * something else. What the operator typed is never shortened either; `plan`
 * warns about it instead.
 */
export function shortenText(text: string, limit: number): Shortened {
  const paragraphs = text.split(/\n\s*\n/);
  let kept = paragraphs.length > MAX_PARAGRAPHS ? paragraphs.slice(0, MAX_PARAGRAPHS).join('\n\n') : text;
  if (kept.length <= limit) return { text: kept.trim(), shortened: kept !== text };

  const head = kept.slice(0, limit);
  let sentenceEnd = -1;
  for (const match of head.matchAll(/[.!?]["')\]]?(?=\s|$)/g)) sentenceEnd = match.index + match[0].length;
  if (sentenceEnd >= MIN_KEPT) kept = head.slice(0, sentenceEnd);
  else {
    const lastSpace = head.lastIndexOf(' ');
    kept = lastSpace >= MIN_KEPT ? head.slice(0, lastSpace) : head;
  }
  return { text: kept.trim(), shortened: true };
}
