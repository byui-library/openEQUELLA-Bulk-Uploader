// tests/ai/review.test.ts
import { describe, it, expect } from 'vitest';
import { needsReview, countNeedingReview, countModelWritten } from '../../src/core/ai/review.js';
import type { ExtractedRow } from '../../src/core/extract/types.js';

const AI_NOTE =
  'MWDL/description: written by a language model from the document text -- please check it before uploading.';

const DATE_NOTE =
  'MWDL/deathDate: written by a language model from the document text, and this column holds a date.';

/** A model write into a prose column. Routine, and subtracted from the count. */
const prose = (note: string) => ({ note, factField: false });
/** A model write into a date, a name or an identifier. NOT subtracted -- see
 *  `needsReview`, and the design's separation of prose from fact. */
const fact = (note: string) => ({ note, factField: true });

const row = (over: Partial<ExtractedRow> = {}): ExtractedRow => ({
  cells: {},
  sources: {},
  notes: [],
  flagged: {},
  aiWritten: {},
  ...over,
});

/**
 * The counter this exists for. `flagIfEmpty`'s own docblock states what is at
 * stake: "the batch's one genuine failure is indistinguishable from a row nobody
 * expected anything from". With a model enabled on one column EVERY row carries
 * a note, so `notes.length > 0` reads 400 of 400 and the signal is gone.
 */
describe('needsReview', () => {
  it('is false for a row with no notes at all', () => {
    expect(needsReview(row())).toBe(false);
  });

  it('is true for a row with an ordinary note', () => {
    expect(needsReview(row({ notes: ['no date could be found'] }))).toBe(true);
  });

  /** The whole point: an expected model write is not a problem to be triaged. */
  it('is false for a row whose only note is a model write', () => {
    const r = row({ notes: [AI_NOTE], aiWritten: { 'MWDL/description': prose(AI_NOTE) } });
    expect(needsReview(r)).toBe(false);
  });

  /** And the genuine failure must survive beside it. */
  it('is true for a row that has a real problem as well as a model write', () => {
    const r = row({
      notes: [AI_NOTE, 'this file has no text layer'],
      aiWritten: { 'MWDL/description': prose(AI_NOTE) },
    });
    expect(needsReview(r)).toBe(true);
  });

  /**
   * BY IDENTITY, NOT BY MATCHING PROSE. `aiWritten` stores the exact string that
   * was pushed onto `notes` precisely so no counter has to recognise the
   * wording -- a note the model pass did NOT write is a real note even when it
   * mentions the model, and a reworded write must not silently start counting.
   */
  it('counts a note the model pass did not write, even one that mentions a model', () => {
    const r = row({
      notes: [AI_NOTE, 'MWDL/abstract: not sent to the model -- this file has no text to read.'],
      aiWritten: { 'MWDL/description': prose(AI_NOTE) },
    });
    expect(needsReview(r)).toBe(true);
  });

  /**
   * The "could not run" note is a REAL problem and must never be subtracted:
   * a column asked for a model and got nothing, which is the failure shape this
   * codebase has shipped four times. It reaches `notes` and not `aiWritten`, so
   * it counts -- pinned here because it would be an easy thing to tidy away.
   */
  it('counts a column that asked for a model there was none of', () => {
    const r = row({ notes: ['MWDL/description: no model is configured, so nothing was written here.'] });
    expect(needsReview(r)).toBe(true);
  });
});

describe('countNeedingReview and countModelWritten', () => {
  const written = row({ notes: [AI_NOTE], aiWritten: { 'MWDL/description': prose(AI_NOTE) } });
  const broken = row({ notes: ['no text layer'] });
  const both = row({ notes: [AI_NOTE, 'no text layer'], aiWritten: { 'MWDL/description': prose(AI_NOTE) } });
  const clean = row();

  it('counts only the rows with a real problem', () => {
    expect(countNeedingReview([written, broken, both, clean])).toBe(2);
  });

  /**
   * REPORTED SEPARATELY RATHER THAN NOT AT ALL. A model wrote into 400
   * catalogue records; the operator is told so, in its own number, because
   * hiding it would be this project's other recurring fault -- work that
   * happened and was not reported. What it must not do is inflate the count of
   * things that went wrong.
   */
  it('counts the rows a model wrote into, separately', () => {
    expect(countModelWritten([written, broken, both, clean])).toBe(2);
  });

  it('is zero on both counts for a batch nothing happened to', () => {
    expect(countNeedingReview([clean, clean])).toBe(0);
    expect(countModelWritten([clean, clean])).toBe(0);
  });
});

/**
 * ## A model-written FACT is not a routine flag
 *
 * The design separates prose from fact and says a fact field "stays flagged for
 * review even when an operator enables them". A description that reads oddly is
 * a quality problem a cataloguer can fix; an invented death date cannot be told
 * from a real one by anyone downstream, permanently, in a collection with no
 * moderation queue.
 *
 * `fill.ts` has already deleted `row.flagged` for the cell by the time this
 * runs, so if the counter subtracts it too, NOTHING on the row says a machine
 * guessed at a date -- and the batch reports "None need review".
 *
 * Nothing ships enabled on a fact column. That is a policy, and this is what
 * stops the policy being the only thing between a batch and the counter.
 */
describe('needsReview and a model-written fact field', () => {
  it('counts a row whose only note is a model-written date', () => {
    const r = row({ notes: [DATE_NOTE], aiWritten: { 'MWDL/deathDate': fact(DATE_NOTE) } });
    expect(needsReview(r)).toBe(true);
  });

  it('still does not count the prose write beside it', () => {
    const r = row({ notes: [AI_NOTE], aiWritten: { 'MWDL/description': prose(AI_NOTE) } });
    expect(needsReview(r)).toBe(false);
  });

  it('counts a row carrying both, once', () => {
    const r = row({
      notes: [AI_NOTE, DATE_NOTE],
      aiWritten: {
        'MWDL/description': prose(AI_NOTE),
        'MWDL/deathDate': fact(DATE_NOTE),
      },
    });
    expect(needsReview(r)).toBe(true);
    expect(countNeedingReview([r])).toBe(1);
  });

  /** Both are still model writes -- the operator is told a machine wrote into
   *  two cells, whatever kind of column they were. */
  it('counts both kinds as model-written', () => {
    const r = row({
      notes: [AI_NOTE, DATE_NOTE],
      aiWritten: {
        'MWDL/description': prose(AI_NOTE),
        'MWDL/deathDate': fact(DATE_NOTE),
      },
    });
    expect(countModelWritten([r])).toBe(1);
  });
});
