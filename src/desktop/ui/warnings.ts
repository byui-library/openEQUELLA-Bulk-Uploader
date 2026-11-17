/**
 * Splits `plan()`'s raw `warnings: string[]` into the buckets the Review
 * screen needs, rather than dumping them as one undifferentiated list (spec:
 * "grouped meaningfully rather than dumped as one list").
 *
 * The message shapes matched here come from `src/core/plan.ts`
 * (`buildManifest`, `preflightDuplicates`) verbatim. Matched by a pattern
 * anchored to the parts of the message that are fixed prose, not the parts
 * that vary per row (row number, filename, identifier) -- so a change to
 * *which* row triggered a warning never breaks the grouping, but a change to
 * the fixed wording itself is a signal this needs to be revisited alongside
 * core/plan.ts.
 */
export interface CategorizedWarnings {
  /** A row named a file that isn't on disk, or named no file at all. */
  missingFile: string[];
  /** A row named a folder that cannot become one contribution: empty, or
   *  holding a folder of its own. A group of its own because the remedy is
   *  in the folder, not in the spreadsheet. */
  refusedFolder: string[];
  /** A file -- or, in a batch that uses folders, a folder -- that no row claimed. */
  unmatchedFile: string[];
  /** An identifier that may already exist in the target collection (or
   *  couldn't be checked) -- advisory, never a silent skip. */
  duplicateIdentifier: string[];
  /** A description longer than one or two paragraphs -- or the batch-wide
   *  word that lengths could not be checked. Advisory; nothing is cut. */
  longDescription: string[];
  /** Anything that doesn't match a known shape. Shown, not dropped, so a
   *  future warning the UI hasn't been taught about is still visible. */
  other: string[];
}

const UNMATCHED_FILE_RE = /has no matching row/;
const MISSING_FILE_RE = /^Row \d+: (?:no '.*' value; skipped\.|.*not found in .*; skipped\.)$/;
const REFUSED_FOLDER_RE = /^Row \d+: folder '.*' cannot be uploaded: .*; skipped\.$/;
// The third alternative is the batch-wide "this schema has no identifier field"
// message (plan.ts#NO_IDENTIFIER_PATH_WARNING). It belongs in this group and not
// in `other`: it is the answer to "were there duplicate identifiers?", and the
// answer is "nobody looked". Grouping it under the heading the operator reads
// for that question is the whole point of reporting it at all.
const DUPLICATE_RE =
  /identifier '.*' may already exist|could not check whether identifier|Duplicate identifiers were not checked/;

const LONG_DESCRIPTION_RE =
  /^Row \d+: the description \('.*'\) is \d+ characters, longer than|^Description lengths were not checked/;

export function categorizeWarnings(warnings: readonly string[]): CategorizedWarnings {
  const out: CategorizedWarnings = {
    missingFile: [],
    refusedFolder: [],
    unmatchedFile: [],
    duplicateIdentifier: [],
    longDescription: [],
    other: [],
  };

  for (const w of warnings) {
    if (UNMATCHED_FILE_RE.test(w)) out.unmatchedFile.push(w);
    else if (REFUSED_FOLDER_RE.test(w)) out.refusedFolder.push(w);
    else if (MISSING_FILE_RE.test(w)) out.missingFile.push(w);
    else if (DUPLICATE_RE.test(w)) out.duplicateIdentifier.push(w);
    else if (LONG_DESCRIPTION_RE.test(w)) out.longDescription.push(w);
    else out.other.push(w);
  }

  return out;
}
