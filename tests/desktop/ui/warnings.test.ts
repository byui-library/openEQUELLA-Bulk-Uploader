import { describe, it, expect } from 'vitest';
import { categorizeWarnings } from '../../../src/desktop/ui/warnings.js';
// Imported, not paraphrased: this one is a fixed sentence the core exports, so
// a reworded warning fails here instead of silently falling into `other`.
import { NO_IDENTIFIER_PATH_WARNING, GUEST_SESSION_WARNING } from '../../../src/core/plan.js';

// Message shapes copied verbatim from src/core/plan.ts (buildManifest,
// preflightDuplicates) so the regexes are checked against what the core
// actually produces, not an idealised paraphrase of it.
const MISSING_ATTACHMENT_VALUE = "Row 5: no 'attachment name' value; skipped.";
const FILE_NOT_FOUND = "Row 7: file 'foo.mp4' not found in C:\\files; skipped.";
const UNMATCHED_FILE = "File 'bar.mp4' has no matching row; not uploaded.";
const DUPLICATE_IDENTIFIER =
  "Row 3: an item with identifier 'ABC123' may already exist in the collection; verify before uploading 'foo.mp4'.";
const DUPLICATE_CHECK_FAILED =
  "Row 4: could not check whether identifier 'XYZ' already exists (network error); verify manually before uploading 'bar.mp4'.";

describe('categorizeWarnings', () => {
  it('returns all-empty buckets for no warnings', () => {
    expect(categorizeWarnings([])).toEqual({
      missingFile: [],
      unmatchedFile: [],
      duplicateIdentifier: [],
      other: [],
    });
  });

  it('buckets a row with no attachment-name value as a missing file', () => {
    expect(categorizeWarnings([MISSING_ATTACHMENT_VALUE]).missingFile).toEqual([MISSING_ATTACHMENT_VALUE]);
  });

  it('buckets a row naming a file not found on disk as a missing file', () => {
    expect(categorizeWarnings([FILE_NOT_FOUND]).missingFile).toEqual([FILE_NOT_FOUND]);
  });

  it('buckets a file with no matching row separately from missing files', () => {
    const got = categorizeWarnings([UNMATCHED_FILE]);
    expect(got.unmatchedFile).toEqual([UNMATCHED_FILE]);
    expect(got.missingFile).toEqual([]);
  });

  it('buckets a possible-duplicate identifier warning', () => {
    expect(categorizeWarnings([DUPLICATE_IDENTIFIER]).duplicateIdentifier).toEqual([DUPLICATE_IDENTIFIER]);
  });

  it('buckets a failed duplicate-check warning with the duplicates, not as unrecognised', () => {
    const got = categorizeWarnings([DUPLICATE_CHECK_FAILED]);
    expect(got.duplicateIdentifier).toEqual([DUPLICATE_CHECK_FAILED]);
    expect(got.other).toEqual([]);
  });

  /**
   * The schema having no identifier field means the check never ran. It is an
   * answer to "were there duplicate identifiers?", so it belongs under that
   * heading -- not in the unrecognised bucket, where it reads as an unrelated
   * stray and is easy to skim past.
   */
  it('buckets the schema-has-no-identifier-field warning with the duplicates', () => {
    const got = categorizeWarnings([NO_IDENTIFIER_PATH_WARNING]);
    expect(got.duplicateIdentifier).toEqual([NO_IDENTIFIER_PATH_WARNING]);
    expect(got.other).toEqual([]);
  });

  /**
   * Same reasoning, different cause: a guest session means the check could not
   * run at all. It is still the answer to "were there duplicate identifiers?",
   * and burying it in `other` -- where it reads as an unrelated stray -- is
   * how an operator skims past the one line saying nothing was checked.
   */
  it('buckets the nobody-is-signed-in warning with the duplicates', () => {
    const got = categorizeWarnings([GUEST_SESSION_WARNING]);
    expect(got.duplicateIdentifier).toEqual([GUEST_SESSION_WARNING]);
    expect(got.other).toEqual([]);
  });

  it('puts an unrecognised message in "other" rather than dropping it', () => {
    const weird = 'Something the core started saying that this UI has never seen before.';
    expect(categorizeWarnings([weird]).other).toEqual([weird]);
  });

  it('sorts a realistic mixed batch into the right buckets, preserving order within each', () => {
    const got = categorizeWarnings([
      MISSING_ATTACHMENT_VALUE,
      UNMATCHED_FILE,
      DUPLICATE_IDENTIFIER,
      FILE_NOT_FOUND,
      DUPLICATE_CHECK_FAILED,
    ]);
    expect(got.missingFile).toEqual([MISSING_ATTACHMENT_VALUE, FILE_NOT_FOUND]);
    expect(got.unmatchedFile).toEqual([UNMATCHED_FILE]);
    expect(got.duplicateIdentifier).toEqual([DUPLICATE_IDENTIFIER, DUPLICATE_CHECK_FAILED]);
    expect(got.other).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [MISSING_ATTACHMENT_VALUE, UNMATCHED_FILE];
    const copy = [...input];
    categorizeWarnings(input);
    expect(input).toEqual(copy);
  });
});
