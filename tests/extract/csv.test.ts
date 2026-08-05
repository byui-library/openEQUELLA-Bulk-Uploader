// tests/extract/csv.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { writeCsv, NOTES_COLUMN, SOURCE_COLUMN } from '../../src/core/extract/csv.js';
import { ATTACHMENT_COLUMN, type ExtractedRow, type Profile } from '../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

function row(cells: Record<string, string>, sources = {}, notes: string[] = []): ExtractedRow {
  return { cells, sources, notes };
}

async function writeAndRead(rows: ExtractedRow[]): Promise<string[][]> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
  const path = join(dir, 'out.csv');
  await writeCsv(path, profile, rows);
  return parse(await readFile(path, 'utf8'), { relax_column_count_less: true }) as string[][];
}

describe('writeCsv', () => {
  it('writes the profile columns in order, then the notes columns', async () => {
    const records = await writeAndRead([row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'A' })]);
    expect(records[0]).toEqual([ATTACHMENT_COLUMN, 'MWDL/title', SOURCE_COLUMN, NOTES_COLUMN]);
  });

  it('writes one line per row', async () => {
    const records = await writeAndRead([
      row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'A' }),
      row({ [ATTACHMENT_COLUMN]: 'b.pdf', 'MWDL/title': 'B' }),
    ]);
    expect(records).toHaveLength(3);
    expect(records[2]?.[0]).toBe('b.pdf');
  });

  it('quotes a value containing a comma so columns do not shift', async () => {
    const records = await writeAndRead([row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'Smith, Jane' })]);
    expect(records[1]?.[1]).toBe('Smith, Jane');
  });

  it('survives a value containing a quote and a newline', async () => {
    const value = 'He said "hello"\nthen left';
    const records = await writeAndRead([row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': value })]);
    expect(records[1]?.[1]).toBe(value);
  });

  it('renders sources as field=source pairs', async () => {
    const records = await writeAndRead([
      row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'A' }, { 'MWDL/title': 'label' }),
    ]);
    expect(records[1]?.[2]).toBe('MWDL/title=label');
  });

  it('joins several notes with a semicolon', async () => {
    const records = await writeAndRead([
      row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': '' }, {}, ['first problem', 'second problem']),
    ]);
    expect(records[1]?.[3]).toBe('first problem; second problem');
  });

  it('writes an empty cell for a column the row has no value for', async () => {
    const records = await writeAndRead([row({ [ATTACHMENT_COLUMN]: 'a.pdf' })]);
    expect(records[1]?.[1]).toBe('');
  });

  it('produces a file the project\'s own sheet reader can read back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    await writeCsv(path, profile, [row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'Smith, Jane' })]);
    const { readSheet } = await import('../../src/core/sheet.js');
    const sheet = await readSheet(path);
    expect(sheet.rows[0]?.cells['MWDL/title']).toBe('Smith, Jane');
  });
});
