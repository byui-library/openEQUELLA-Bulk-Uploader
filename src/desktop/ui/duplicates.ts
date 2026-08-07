import { defaultChoice, type DuplicateChoice, type DuplicateFinding } from '../../core/duplicates.js';

/**
 * The rows to mark skipped, from the findings and whatever the operator chose.
 *
 * Extracted from the upload handler so it can be tested at all: inlined there
 * it sat behind an IPC call, and inverting its comparison -- dropping every row
 * the operator wanted kept -- passed the entire test suite.
 *
 * A row with no explicit choice takes its tier's default, which is `skip` only
 * for `near-certain`.
 */
export function rowsToSkip(
  duplicates: readonly DuplicateFinding[],
  choices: Readonly<Record<number, DuplicateChoice>>,
): number[] {
  return duplicates
    .filter((d) => (choices[d.rowNumber] ?? defaultChoice(d.tier)) === 'skip')
    .map((d) => d.rowNumber);
}
