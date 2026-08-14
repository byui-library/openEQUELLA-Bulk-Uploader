// src/core/ai/review.ts
//
// PURE, and free of `node:*`, so `src/desktop/ui/` may import it -- the preview
// screen counts the same way the run report does. The renderer is sandboxed and
// a Node import anywhere it can reach blanks the window silently.
import type { ExtractedRow } from '../extract/types.js';

/**
 * Does this row carry a problem somebody has to look at?
 *
 * ## What it exists to stop
 *
 * Both surfaces used to count "rows needing review" as `notes.length > 0`. That
 * was right while every note meant something had gone wrong. With a model
 * enabled on one column, EVERY row it wrote carries a note -- because every
 * model write is flagged, without exception, which is the safety property the
 * whole feature rests on -- so a batch of four hundred reads "400 of 400 need
 * review" and the one row that genuinely failed is invisible.
 *
 * `flagIfEmpty`'s own docblock names the loss: "the batch's one genuine failure
 * is indistinguishable from a row nobody expected anything from". Turning every
 * row into a flagged row destroys exactly that, and it would do it to a signal
 * an operator uses to decide which of four hundred spreadsheet rows to open.
 *
 * ## By identity, never by matching the note's prose
 *
 * `aiWritten` stores the exact string the fill pass pushed onto `notes` (see
 * `ExtractedRow.aiWritten`), so this subtracts by set membership. Recognising
 * the wording instead would be wrong in both directions: a reworded note would
 * silently stop being subtracted, and a DIFFERENT note that happens to mention
 * a model -- "not sent to the model -- this file has no text to read" -- would
 * start being subtracted although it is a real failure.
 *
 * ## What is deliberately NOT subtracted
 *
 * "No model is configured, so nothing was written here" is a genuine problem: a
 * column asked for a value and did not get one. It reaches `notes` and never
 * `aiWritten`, so it counts -- and it must, because a thing that could not run
 * being reported as if it had is the failure this codebase has shipped four
 * times.
 */
export function needsReview(row: ExtractedRow): boolean {
  const written = new Set(Object.values(row.aiWritten));
  return row.notes.some((note) => !written.has(note));
}

/** Rows with something genuinely wrong. The triage number. */
export function countNeedingReview(rows: readonly ExtractedRow[]): number {
  return rows.filter(needsReview).length;
}

/**
 * Rows a language model wrote into.
 *
 * REPORTED IN ITS OWN NUMBER RATHER THAN NOT AT ALL. A machine wrote text that
 * is about to become a permanent catalogue record; the operator is told how many
 * times, beside the count of things that went wrong rather than added into it.
 * Suppressing it entirely would be this project's other recurring fault -- work
 * that happened and was never mentioned -- and the two numbers answer different
 * questions: "what must I fix" and "what did a machine write".
 */
export function countModelWritten(rows: readonly ExtractedRow[]): number {
  return rows.filter((row) => Object.keys(row.aiWritten).length > 0).length;
}
