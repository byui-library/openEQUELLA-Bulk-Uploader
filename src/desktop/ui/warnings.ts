/**
 * Splits `plan()`'s raw `warnings: string[]` into the buckets the Review
 * screen needs, rather than dumping them as one undifferentiated list (spec:
 * "grouped meaningfully rather than dumped as one list").
 *
 * The three message shapes matched here come from `src/core/plan.ts`
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
  /** A file on disk that no row claimed. */
  unmatchedFile: string[];
  /** An identifier that may already exist in the target collection (or
   *  couldn't be checked) -- advisory, never a silent skip. */
  duplicateIdentifier: string[];
  /** Anything that doesn't match a known shape. Shown, not dropped, so a
   *  future warning the UI hasn't been taught about is still visible. */
  other: string[];
}

const UNMATCHED_FILE_RE = /has no matching row/;
const MISSING_FILE_RE = /^Row \d+: (?:no '.*' value; skipped\.|.*not found in .*; skipped\.)$/;
const DUPLICATE_RE = /identifier '.*' may already exist|could not check whether identifier/;

export function categorizeWarnings(warnings: readonly string[]): CategorizedWarnings {
  const out: CategorizedWarnings = { missingFile: [], unmatchedFile: [], duplicateIdentifier: [], other: [] };

  for (const w of warnings) {
    if (UNMATCHED_FILE_RE.test(w)) out.unmatchedFile.push(w);
    else if (MISSING_FILE_RE.test(w)) out.missingFile.push(w);
    else if (DUPLICATE_RE.test(w)) out.duplicateIdentifier.push(w);
    else out.other.push(w);
  }

  return out;
}
