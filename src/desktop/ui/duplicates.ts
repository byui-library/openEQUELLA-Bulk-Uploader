import {
  defaultChoice,
  type DuplicateChoice,
  type DuplicateFinding,
  type DuplicateTier,
} from '../../core/duplicates.js';
import { escapeHtml } from './dom.js';

const TIER_LABEL: Record<DuplicateTier, string> = {
  'near-certain': 'Almost certainly already uploaded',
  possible: 'Possibly already uploaded',
  'not-checkable': 'Could not be checked',
  'could-not-check': 'Could not be checked',
};

/**
 * The "Possible duplicates" table on the Review screen, as a pure string.
 *
 * This is the one part of that screen that can be tested without a DOM --
 * there is no jsdom/environment configured in this project (see
 * vitest.config.ts) -- and it had never run against a real finding at all:
 * the data that feeds it is still hard-coded empty upstream. Moved out of
 * screens/review.ts (which stays a thin renderer wired to a live DOM) so it
 * can be asserted as a string, the same way canContinueReview and
 * rowsToSkip already are.
 */
export function duplicatesSection(
  duplicates: readonly DuplicateFinding[],
  choices: Readonly<Record<number, DuplicateChoice>>,
): string {
  if (duplicates.length === 0) {
    return '';
  }

  const duplicateRows = duplicates
    .map((d) => {
      const choice = choices[d.rowNumber] ?? defaultChoice(d.tier);
      // `d.tier` crosses IPC, so an unrecognised value would make the lookup
      // undefined and escapeHtml throw mid-render -- a blank window with
      // nothing in the terminal.
      const label = TIER_LABEL[d.tier] ?? 'Possibly already uploaded';
      // The hint tells the operator to check for themselves, which they cannot
      // do without being told what the matched item already holds.
      const held = d.existing.flatMap((e) => e.attachmentNames).slice(0, 3);
      const heldLine =
        held.length > 0
          ? `<br><small>Existing item holds: ${held.map(escapeHtml).join(', ')}</small>`
          : '';
      return `
      <tr>
        <td>${d.rowNumber}</td>
        <td>${escapeHtml(d.fileName)}</td>
        <td>${escapeHtml(label)}<br><small>${escapeHtml(d.detail)}</small>${heldLine}</td>
        <td>
          <label><input type="radio" name="dup-${d.rowNumber}" value="skip"
            ${choice === 'skip' ? 'checked' : ''}> Skip</label>
          <label><input type="radio" name="dup-${d.rowNumber}" value="upload"
            ${choice === 'upload' ? 'checked' : ''}> Upload anyway</label>
        </td>
      </tr>`;
    })
    .join('');

  return `
      <fieldset>
        <legend>Possible duplicates (${duplicates.length})</legend>
        <p class="hint">
          Rows that look like they have been uploaded to this collection before.
          Only the almost-certain ones are set to skip &mdash; two items can
          share a title, so check the rest yourself.
        </p>
        <table class="review-table">
          <thead><tr><th>Row</th><th>File</th><th>Why</th><th>What to do</th></tr></thead>
          <tbody>${duplicateRows}</tbody>
        </table>
      </fieldset>`;
}

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
