// tests/ai/eligible.test.ts
import { describe, it, expect } from 'vitest';
import { eligibleColumns } from '../../src/core/ai/eligible.js';
import { buildRow } from '../../src/core/extract/rows.js';
import { ATTACHMENT_COLUMN, type DocumentData, type ExtractedRow, type Profile } from '../../src/core/extract/types.js';

const PROSE =
  'A sentence long enough to be taken as an opening paragraph by the reader, with plenty of lowercase words in it.';
const doc = (text: string): DocumentData => ({ text, hasTextLayer: true, properties: {}, tables: [] });

const profile: Profile = {
  version: 1,
  pattern: '{name}.pdf',
  columns: [
    { path: 'MWDL/description', sources: [{ opening: true }, { ai: true }] },
    { path: 'MWDL/title', sources: [{ filenameStem: true }] },
  ],
};

const row = (over: Partial<ExtractedRow> = {}): ExtractedRow => ({
  cells: { 'MWDL/description': '', 'MWDL/title': 'A Title' },
  sources: {},
  notes: [],
  flagged: {},
  ...over,
});

describe('eligibleColumns', () => {
  it('offers an empty cell in a column that asked for a model', () => {
    expect(eligibleColumns(profile, row())).toEqual(['MWDL/description']);
  });

  /** The amendment to the August design: a guess may be replaced. */
  it('offers a cell the extractor already flagged as a guess', () => {
    const r = row({
      cells: { 'MWDL/description': 'Possibly a description', 'MWDL/title': 'A Title' },
      flagged: { 'MWDL/description': 'taken from the start of the document' },
    });
    expect(eligibleColumns(profile, r)).toEqual(['MWDL/description']);
  });

  /** The safety property. A stated value is evidence; a model output is not. */
  it('never offers a value the document stated', () => {
    const r = row({ cells: { 'MWDL/description': 'A real abstract', 'MWDL/title': 'A Title' } });
    expect(eligibleColumns(profile, r)).toEqual([]);
  });

  it('never offers a column that did not ask for a model', () => {
    const r = row({ cells: { 'MWDL/description': 'x', 'MWDL/title': '' } });
    expect(eligibleColumns(profile, r)).toEqual([]);
  });

  it('treats whitespace as empty', () => {
    const r = row({ cells: { 'MWDL/description': '   ', 'MWDL/title': 'A Title' } });
    expect(eligibleColumns(profile, r)).toEqual(['MWDL/description']);
  });

  /**
   * `flagged` is asked about THIS column, never about the row. A guess
   * elsewhere -- a title taken from the opening paragraph -- must not make a
   * stated description replaceable. Without this, "was this cell flagged" and
   * "was anything on this row flagged" are indistinguishable, and the safety
   * property inverts.
   */
  it('does not let a flag on another column make a stated value replaceable', () => {
    const r = row({
      cells: { 'MWDL/description': 'A real abstract', 'MWDL/title': 'A Title' },
      flagged: { 'MWDL/title': 'taken from the start of the document' },
    });
    expect(eligibleColumns(profile, r)).toStrictEqual([]);
  });
});

/**
 * Both of these are driven through `buildRow` rather than a hand-built row,
 * because in each case the defect IS the interaction between the two: a row
 * literal written by hand would encode what this file believes buildRow
 * produces, which is exactly the belief that was wrong.
 */
describe('columns the model may never write, whatever the profile says', () => {
  /**
   * `attachment name` names the file on disk. `buildRow` overrides its value
   * with the filename AFTER `fill` recorded the note, so the row arrives with
   * a real filename in the cell and a flag describing the value it threw away
   * -- flagged, non-empty, and eligible under the plain rule.
   *
   * Task 7's fill pass assigns `row.cells[path] = reply`, so offering this
   * column renames the attachment and breaks the one-file-one-item
   * relationship the whole tool rests on. `profile.ts` already refuses a
   * composed attachment column and `rows.ts` re-applies the override in both
   * passes, both for this reason; this is the third door in the same wall.
   */
  it('never offers the attachment column, whose value is the file on disk', () => {
    const withAttachment: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [{ path: ATTACHMENT_COLUMN, sources: [{ opening: true }, { ai: true }], locked: true }],
    };
    const built = buildRow(withAttachment, 'Hawthorn_obituary.pdf', doc(PROSE));

    // The trap is real, not hypothetical: assert the shape that makes this
    // column look eligible, so the test cannot pass by the trap disappearing.
    expect(built.cells[ATTACHMENT_COLUMN]).toBe('Hawthorn_obituary.pdf');
    expect(built.flagged[ATTACHMENT_COLUMN]).toBeDefined();

    expect(eligibleColumns(withAttachment, built)).toStrictEqual([]);
  });

  /**
   * A composeOnly column is dropped before it gets a `cells` entry, so its
   * value reads as empty for ever and it qualifies on every row. Nothing
   * writes it -- `csv.ts` filters it from the headers -- and the composed
   * column that reads it was already built in pass 2, before any async pass
   * runs. So every call would be paid for and discarded.
   */
  it('never offers a composeOnly column, whose value reaches no spreadsheet', () => {
    const composeOnlyProfile: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/birthDate', sources: [{ ai: true }], as: 'birth', composeOnly: true },
      ],
    };
    const built = buildRow(composeOnlyProfile, 'a.pdf', doc(''));

    // Again the trap: no cell at all, which is what reads as empty.
    expect(built.cells['MWDL/birthDate']).toBeUndefined();

    expect(eligibleColumns(composeOnlyProfile, built)).toStrictEqual([]);
  });
});
