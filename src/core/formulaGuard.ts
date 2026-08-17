// src/core/formulaGuard.ts

/**
 * Stopping a document's text from becoming a live formula in Excel, without
 * changing what the value IS.
 *
 * The extractor writes text it read out of PDFs and Word files into a
 * spreadsheet the operator opens in Excel. Excel does not treat a cell
 * beginning `=`, `+`, `-` or `@` as text -- it treats it as a formula and runs
 * it, and the DDE forms of that reach outside the spreadsheet entirely. The
 * documents come from donors, families and other departments, are frequently
 * scanned, and nobody reads all of them first: they are the one input to this
 * tool that an outsider supplies.
 *
 * THE TWO HALVES MUST STAY SYMMETRIC, WHICH IS WHY THEY LIVE IN ONE MODULE.
 * `plan` reads the extractor's own spreadsheet back and uploads what it finds,
 * so an escape added on the way out and not removed on the way in would write a
 * stray apostrophe into a permanent catalogue record -- a data-integrity bug
 * introduced by a security fix, which is a bad trade in a tool whose whole
 * purpose is faithful records. `unguardFormula(guardFormula(v))` is `v` for
 * every string, and `tests/formulaGuard.test.ts` pins that over every shape
 * the two functions distinguish.
 *
 * The cost is visible and accepted: a description that genuinely starts with
 * `-` shows a leading apostrophe in Excel. It is removed again on the way to
 * openEQUELLA, so what is catalogued is what the document said.
 */

/**
 * The characters Excel reads as the start of a formula, plus the two control
 * characters it strips before deciding -- so `\t=cmd` is a formula too.
 */
const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/** The escape character. Excel's own convention for "this cell is text". */
const GUARD = "'";

/**
 * Make a value safe to write into a spreadsheet cell.
 *
 * A value already starting with the guard character is escaped as well. Without
 * that, `'=SUM(A1)` read back is indistinguishable from a guarded `=SUM(A1)`,
 * and the reader would strip an apostrophe that was always part of the data.
 */
export function guardFormula(value: string): string {
  const first = value[0];
  if (first === undefined) return value;
  if (first === GUARD || TRIGGERS.includes(first)) return GUARD + value;
  return value;
}

/** Undo exactly one `guardFormula`. Anything else is left as it is. */
export function unguardFormula(value: string): string {
  if (value[0] !== GUARD) return value;
  const second = value[1];
  if (second === undefined) return value;
  if (second === GUARD || TRIGGERS.includes(second)) return value.slice(1);
  return value;
}
