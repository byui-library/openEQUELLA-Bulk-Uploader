// tests/ai/eligible.test.ts
import { describe, it, expect } from 'vitest';
import { eligibleColumns } from '../../src/core/ai/eligible.js';
import type { ExtractedRow, Profile } from '../../src/core/extract/types.js';

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
});
