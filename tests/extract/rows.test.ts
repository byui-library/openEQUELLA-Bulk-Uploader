// tests/extract/rows.test.ts
import { describe, it, expect } from 'vitest';
import { buildRow, normaliseDate } from '../../src/core/extract/rows.js';
import { ATTACHMENT_COLUMN, type DocumentData, type Profile } from '../../src/core/extract/types.js';

const EMPTY_DOC: DocumentData = { text: '', hasTextLayer: true, properties: {} };

const profile: Profile = {
  version: 1,
  pattern: '{last}_{first}_{title}_{date}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }, { label: 'Title' }] },
    { path: 'MWDL/creators/creator', sources: [{ join: '{last}, {first}' }, { label: 'Performer' }] },
    { path: 'MWDL/date', sources: [{ placeholder: 'date' }, { property: 'created' }], transform: 'date' },
    { path: 'MWDL/publisher', sources: [], default: 'BYU-Idaho' },
    { path: 'MWDL/description', sources: [] },
  ],
};

describe('normaliseDate', () => {
  it('passes an ISO date through', () => {
    expect(normaliseDate('2026-04-12')).toBe('2026-04-12');
  });

  it('normalises a long form date', () => {
    expect(normaliseDate('April 12, 2026')).toBe('2026-04-12');
  });

  it('returns null for something that is not a date', () => {
    expect(normaliseDate('Recital_2026')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(normaliseDate('')).toBeNull();
  });

  // The bare-year guard. V8 parses new Date('1953') successfully, to
  // 1953-01-01 -- inventing a month and a day that were never in the source.
  // Year-only dates are ordinary in digitised material, so this is not an
  // edge case. A mutation pass found that deleting both guard lines broke no
  // test, because the existing "not a date" inputs are rejected by V8 anyway.
  it('returns null for a bare year rather than inventing January the 1st', () => {
    expect(normaliseDate('1953')).toBeNull();
    expect(normaliseDate('2026')).toBeNull();
  });

  // Word writes `created` as a UTC timestamp. Reading local date parts off it
  // shifted the day backwards for any time before the UTC offset -- a silently
  // wrong date, with no note, on a published item. Found by running against 59
  // real .docx files. The date part of an ISO timestamp is taken verbatim now;
  // no Date parsing, so no timezone can be involved.
  it('takes the date from an ISO timestamp without shifting the day', () => {
    expect(normaliseDate('2025-12-04T01:00:00Z')).toBe('2025-12-04');
    expect(normaliseDate('2025-06-04T02:30:00Z')).toBe('2025-06-04');
    expect(normaliseDate('2025-12-03T23:58:00Z')).toBe('2025-12-03');
  });

  it('takes the date from an ISO timestamp with a non-UTC offset', () => {
    expect(normaliseDate('2025-12-04T01:00:00+13:00')).toBe('2025-12-04');
  });

  it('returns null for a value with no four-digit year at all', () => {
    expect(normaliseDate('April')).toBeNull();
    expect(normaliseDate('12/04')).toBeNull();
  });
});

describe('buildRow', () => {
  it('fills the attachment column with the filename verbatim', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells[ATTACHMENT_COLUMN]).toBe('Smith_Jane_Recital_2026-04-12.pdf');
  });

  it('takes the first non-empty source and does not overwrite it', () => {
    const doc: DocumentData = { ...EMPTY_DOC, text: 'Title: A Different Title\n' };
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', doc);
    expect(row.cells['MWDL/title']).toBe('Recital');
    expect(row.sources['MWDL/title']).toBe('filename');
  });

  it('falls through to a later source when an earlier one is empty', () => {
    const doc: DocumentData = { ...EMPTY_DOC, text: 'Performer: Anna Lee\n' };
    const row = buildRow({ ...profile, pattern: '{title}.pdf' }, 'Recital.pdf', doc);
    expect(row.cells['MWDL/creators/creator']).toBe('Anna Lee');
    expect(row.sources['MWDL/creators/creator']).toBe('label');
  });

  it('joins placeholders', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/creators/creator']).toBe('Smith, Jane');
  });

  it('applies a default when every source was empty', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/publisher']).toBe('BYU-Idaho');
    expect(row.sources['MWDL/publisher']).toBe('default');
  });

  it('leaves a column with no source and no default empty, without a note', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/description']).toBe('');
    expect(row.notes.join(' ')).not.toContain('description');
  });

  it('normalises a date', () => {
    const doc: DocumentData = { ...EMPTY_DOC, properties: { created: 'April 12, 2026' } };
    const row = buildRow({ ...profile, pattern: '{title}.pdf' }, 'Recital.pdf', doc);
    expect(row.cells['MWDL/date']).toBe('2026-04-12');
  });

  // Exactly four underscore-separated tokens, matching the four placeholders.
  // A fifth token would be absorbed by {date} through the lazy matching that
  // pattern.ts documents and tests, giving 'Recital_x' rather than 'x'.
  it('keeps an unrecognisable date verbatim and says so', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_x.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/date']).toBe('x');
    expect(row.notes.join(' ')).toMatch(/not recognised as a date/i);
  });

  // The same guard as above, but reached the way a real batch would reach it:
  // through a filename whose date part is just a year. The cell must keep the
  // year as found and say so, not silently become the first of January.
  it('keeps a year-only date verbatim instead of inventing a month and day', () => {
    const row = buildRow({ ...profile, pattern: '{title}_{date}.pdf' }, 'Recital_1953.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/date']).toBe('1953');
    expect(row.notes.join(' ')).toMatch(/not recognised as a date/i);
  });

  it('notes when the filename does not match the pattern, and still returns a row', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(row.cells[ATTACHMENT_COLUMN]).toBe('unmatched.pdf');
    expect(row.cells['MWDL/title']).toBe('');
    expect(row.notes.join(' ')).toMatch(/does not match the pattern/i);
  });

  it('notes a missing text layer', () => {
    const doc: DocumentData = { ...EMPTY_DOC, hasTextLayer: false };
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', doc);
    expect(row.notes.join(' ')).toMatch(/no text layer/i);
  });

  it('includes every profile column, even the empty ones', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(Object.keys(row.cells)).toEqual(profile.columns.map((c) => c.path));
  });

  it('records sources only for columns that got a value', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(row.sources['MWDL/title']).toBeUndefined();
    expect(row.sources[ATTACHMENT_COLUMN]).toBe('filename');
  });
});
