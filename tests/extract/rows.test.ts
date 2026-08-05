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
