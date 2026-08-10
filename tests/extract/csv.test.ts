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
  // `bom: true` because the file now starts with a UTF-8 byte-order mark, which
  // is what makes Excel read accents correctly. A reader that does not skip it
  // sees the mark glued to the FIRST column name and nothing else wrong -- the
  // same failure shape that once broke .env parsing here. src/core/sheet.ts
  // handles it, and this helper stands in for any other well-behaved reader.
  return parse(await readFile(path, 'utf8'), {
    relax_column_count_less: true,
    bom: true,
  }) as string[][];
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

  // Excel decides a CSV's encoding from its first bytes. Without a byte-order
  // mark it assumes the system codepage, so UTF-8 accents arrive as mojibake --
  // "Ibáñez" shown as "IbÃ¡Ã±ez". The bytes were always right; Excel was
  // reading them wrongly, and this feature's whole promise is "open it in
  // Excel and check it". Found on a real extraction of journal articles.
  it('starts with a UTF-8 byte-order mark so Excel reads accents correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    await writeCsv(path, profile, [row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'Ibáñez' })]);
    const bytes = await readFile(path);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('round-trips accented characters and an em dash through readSheet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    const value = 'Sergio J. Ibáñez — José Pino-Ortega';
    await writeCsv(path, profile, [row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': value })]);
    const { readSheet } = await import('../../src/core/sheet.js');
    const sheet = await readSheet(path);
    expect(sheet.rows[0]?.cells['MWDL/title']).toBe(value);
  });

  // The BOM must not leak into the first header. That is exactly how a BOM
  // broke .env parsing in this project before: it corrupts the FIRST field
  // only, so most of the file looks fine and the failure is baffling.
  it('does not let the byte-order mark corrupt the first column name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    await writeCsv(path, profile, [row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'x' })]);
    const { readSheet } = await import('../../src/core/sheet.js');
    const sheet = await readSheet(path);
    expect(sheet.headers[0]).toBe(ATTACHMENT_COLUMN);
    expect(sheet.rows[0]?.cells[ATTACHMENT_COLUMN]).toBe('a.pdf');
  });

  it('produces a file the project\'s own sheet reader can read back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    await writeCsv(path, profile, [row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'Smith, Jane' })]);
    const { readSheet } = await import('../../src/core/sheet.js');
    const sheet = await readSheet(path);
    expect(sheet.rows[0]?.cells['MWDL/title']).toBe('Smith, Jane');
  });

  // A composeOnly column is extracted only so `compose` can read it -- it must
  // never reach the spreadsheet, which is the whole reason it exists instead
  // of an ordinary column pointed at the wrong schema field.
  it('omits a composeOnly column from the header row', async () => {
    const withComposeOnly: Profile = {
      version: 1,
      pattern: '{title}.pdf',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/coverage', as: 'birth', composeOnly: true, sources: [] },
        { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      ],
    };
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    await writeCsv(path, withComposeOnly, [row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'A' })]);
    const records = parse(await readFile(path, 'utf8'), {
      relax_column_count_less: true,
      bom: true,
    }) as string[][];
    expect(records[0]).toEqual([ATTACHMENT_COLUMN, 'MWDL/title', SOURCE_COLUMN, NOTES_COLUMN]);
    expect(records[0]).not.toContain('MWDL/coverage');
  });
});
