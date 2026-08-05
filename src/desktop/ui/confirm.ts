import type { ItemState } from '../../core/types.js';

/**
 * The Confirm screen's publish safety gate (spec: "Publishing requires
 * typing the item count... The Upload button stays disabled until the typed
 * number matches. A dialog with an OK button is not a safeguard; people
 * click through those.").
 *
 * Draft is the default and never requires the typed count -- the gate exists
 * specifically to make PUBLISHING (no moderation workflow; items become
 * visible immediately) deliberately harder to click into than the safe
 * default, not to add friction everywhere.
 *
 * For 'published', the typed value must -- after trimming ONLY surrounding
 * whitespace -- consist entirely of ASCII digits and equal `itemCount`
 * exactly:
 *  - '' or whitespace-only: false (nothing meaningful typed; trimming to ''
 *    still fails the \d+ check below, it does not count as "matches 0").
 *  - non-numeric ('twelve'), trailing junk ('12x'), a decimal ('12.0'), a
 *    signed number ('+12'), or scientific notation ('1e2'): all false. The
 *    \d+ regex accepts only bare digits, so none of `Number()`'s more
 *    permissive parsing (which treats all of the above as valid numbers) can
 *    slip past it.
 *  - a wrong count: false.
 *  - the exact count, optionally padded with surrounding whitespace (a
 *    pasted value with a trailing newline shouldn't fail on that alone):
 *    true.
 */
export function canUpload(itemState: ItemState, itemCount: number, typedCount: string): boolean {
  if (itemCount <= 0) return false;
  if (itemState === 'draft') return true;
  const trimmed = typedCount.trim();
  return /^\d+$/.test(trimmed) && Number(trimmed) === itemCount;
}
