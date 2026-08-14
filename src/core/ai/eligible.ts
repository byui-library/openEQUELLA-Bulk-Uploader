// src/core/ai/eligible.ts
import type { ExtractedRow, Profile } from '../extract/types.js';

/**
 * The columns a model may write in this row.
 *
 * THE SAFETY PROPERTY OF THE FEATURE. A column qualifies when its profile
 * asked for a model AND the cell is either empty or was flagged as a guess.
 *
 * A STATED VALUE IS NEVER REPLACED. It is evidence the document supplied; a
 * model output is not, and this tool writes to a permanent catalogue with no
 * moderation queue.
 *
 * "Flagged" is not judged here -- `buildRow` already recorded which cells its
 * tiers were unsure about. So a tier that starts flagging itself becomes
 * model-replaceable with nobody having to remember, and this function cannot
 * drift out of step with the sources.
 */
export function eligibleColumns(profile: Profile, row: ExtractedRow): string[] {
  return profile.columns
    .filter((column) => column.sources.some((s) => 'ai' in s))
    .filter((column) => {
      const value = (row.cells[column.path] ?? '').trim();
      return value === '' || row.flagged[column.path] !== undefined;
    })
    .map((column) => column.path);
}
