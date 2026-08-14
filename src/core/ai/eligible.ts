// src/core/ai/eligible.ts
import { ATTACHMENT_COLUMN, type Column, type ExtractedRow, type Profile } from '../extract/types.js';

/**
 * The columns of this profile a model could ever write, whatever any row holds.
 *
 * THE COLUMN HALF OF THE RULE, ON ITS OWN, because two callers need exactly
 * this and neither can answer it from a row. `eligibleColumns` below applies the
 * per-cell half on top; the desktop's confirmation dialog (ui/aiConfirm.ts)
 * multiplies the count by the number of documents to say how many requests a
 * run may make, before a single file has been read and long before any row
 * exists.
 *
 * SHARED RATHER THAN RE-DERIVED, and that is the whole reason it is a function.
 * A dialog that counted `sources.some(s => 'ai' in s)` itself would quote the
 * operator a number for work the run then never does -- the two exclusions
 * below are invisible to anyone reading the profile, and a batch of 400 rows
 * would be confirmed as 800 requests because of a compose-only column that
 * cannot receive one. Worse in the other direction too: a future exclusion
 * added here would silently stop being reflected in what the operator agreed
 * to.
 */
export function modelColumns(profile: Profile): Column[] {
  return (
    profile.columns
      .filter((column) => column.sources.some((s) => 'ai' in s))
      /*
       * Two columns can never be written, whatever a profile asks for, and both
       * would otherwise qualify through a quirk of how the row is built rather
       * than through the rule.
       *
       * ATTACHMENT_COLUMN names the file on disk. `buildRow` overrides its
       * value with the filename AFTER `fill` recorded the note, so the row
       * arrives flagged about a value it threw away while the cell holds a real
       * filename. Writing here renames the attachment and breaks the
       * one-file-one-item relationship the whole tool rests on. `profile.ts`
       * refuses a composed attachment column and `rows.ts` re-applies the
       * override in both passes for the same reason; this is the third door in
       * that wall.
       *
       * A composeOnly column is dropped before it gets a `cells` entry, so it
       * reads as empty for ever and would qualify on every row -- one paid call
       * per row whose output nothing writes and nothing reads: `csv.ts` filters
       * it out of the headers, and the composed column that consumes it was
       * already built in pass 2, before any async pass runs.
       */
      .filter((column) => column.path !== ATTACHMENT_COLUMN && column.composeOnly !== true)
  );
}

/**
 * The columns a model may write in this row.
 *
 * THE SAFETY PROPERTY OF THE FEATURE. A column qualifies when its profile
 * asked for a model AND the cell is either empty or carries a note some source
 * attached to it.
 *
 * A VALUE NO SOURCE EXPRESSED DOUBT ABOUT IS NEVER REPLACED. Where a source
 * returned a value and said nothing about it, that value is the document's;
 * a model output is not, and this tool writes to a permanent catalogue with no
 * moderation queue.
 *
 * "Flagged" is not judged here -- `buildRow` already recorded which cells its
 * sources were unsure about. So a source that starts flagging itself becomes
 * model-replaceable with nobody having to remember, and this function cannot
 * drift out of step with the sources. Note the question is asked about THIS
 * column: a guess elsewhere on the row says nothing about this cell.
 */
export function eligibleColumns(profile: Profile, row: ExtractedRow): string[] {
  return modelColumns(profile)
    .filter((column) => {
      const value = (row.cells[column.path] ?? '').trim();
      return value === '' || row.flagged[column.path] !== undefined;
    })
    .map((column) => column.path);
}
