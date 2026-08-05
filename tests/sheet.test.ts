import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { readSheet } from '../src/core/sheet.js';
import { SheetError } from '../src/core/errors.js';
import type { Sheet } from '../src/core/types.js';

describe('readSheet (csv)', () => {
  it('reads headers and rows', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    expect(sheet.headers[0]).toBe('MWDL/identifier');
    expect(sheet.headers).toContain('attachment name');
    expect(sheet.rows).toHaveLength(3);
  });

  it('numbers rows from 2, matching the spreadsheet', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    expect(sheet.rows[0]!.rowNumber).toBe(2);
    expect(sheet.rows[2]!.rowNumber).toBe(4);
  });

  it('preserves quotes and commas inside a quoted field', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    const desc = sheet.rows[0]!.cells['MWDL/description']!;
    expect(desc).toContain('"Download linked file"');
    expect(desc).toContain('; for Windows');
  });

  it('preserves filenames with odd spacing and mixed-case extensions', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    expect(sheet.rows[1]!.cells['attachment name']).toBe('Birch ,Rowan 010125.MP4');
    expect(sheet.rows[2]!.cells['attachment name']).toBe('Cedar (Thorn), Wren 010225.mp4');
  });

  it('represents blank cells as empty strings, not undefined', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    expect(sheet.rows[0]!.cells['MWDL/abstract']).toBe('');
  });
});

describe('readSheet (xlsx)', () => {
  let tmpDir: string;
  let mirrorPath: string;
  let edgeCasePath: string;
  let csvSheet: Sheet;

  beforeAll(async () => {
    // Derive the xlsx fixture data from the csv fixture itself (not hand-typed
    // literals) so the two formats can never silently drift apart.
    csvSheet = await readSheet('tests/fixtures/sample-batch.csv');

    tmpDir = await mkdtemp(join(tmpdir(), 'oeq-sheet-'));

    // A workbook mirroring the csv fixture exactly: same headers, same rows.
    mirrorPath = join(tmpDir, 'sample-batch.xlsx');
    const mirrorWb = new ExcelJS.Workbook();
    const mirrorWs = mirrorWb.addWorksheet('Sheet1');
    mirrorWs.addRow(csvSheet.headers);
    for (const row of csvSheet.rows) {
      mirrorWs.addRow(csvSheet.headers.map((h) => row.cells[h]));
    }
    await mirrorWb.xlsx.writeFile(mirrorPath);

    // A second, separate workbook for edge cases that csv can't represent:
    // a numeric (not text) cell, and trailing cells that are never written
    // at all rather than written-and-empty. ExcelJS's row.values is a sparse
    // 1-indexed array, so unset trailing cells are simply absent from it.
    edgeCasePath = join(tmpDir, 'edge-cases.xlsx');
    const edgeWb = new ExcelJS.Workbook();
    const edgeWs = edgeWb.addWorksheet('Sheet1');
    edgeWs.addRow(['id', 'count', 'trailing1', 'trailing2']);
    edgeWs.addRow(['edge-1', 42]); // trailing1 and trailing2 are never set
    await edgeWb.xlsx.writeFile(edgeCasePath);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('produces a Sheet identical to the csv reader for the same data', async () => {
    const xlsxSheet = await readSheet(mirrorPath);
    expect(xlsxSheet).toEqual(csvSheet);
  });

  it('numbers rows from 2, matching the spreadsheet', async () => {
    const xlsxSheet = await readSheet(edgeCasePath);
    expect(xlsxSheet.rows[0]!.rowNumber).toBe(2);
  });

  it('represents a genuinely absent trailing cell as an empty string, not undefined', async () => {
    const xlsxSheet = await readSheet(edgeCasePath);
    expect(xlsxSheet.rows[0]!.cells['trailing1']).toBe('');
    expect(xlsxSheet.rows[0]!.cells['trailing2']).toBe('');
  });

  it('stringifies a numeric cell value', async () => {
    const xlsxSheet = await readSheet(edgeCasePath);
    expect(xlsxSheet.rows[0]!.cells['count']).toBe('42');
    expect(typeof xlsxSheet.rows[0]!.cells['count']).toBe('string');
  });
});

describe('readSheet (unsupported)', () => {
  it('rejects unsupported extensions with a SheetError naming the extension', async () => {
    await expect(readSheet('notes.txt')).rejects.toThrow(SheetError);
    await expect(readSheet('notes.txt')).rejects.toThrow(/unsupported.*\.txt/i);
  });
});

describe('readSheet (xlsx) — formula, rich-text, date, and error cells', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oeq-sheet-cells-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves formula results (string and number), rich text, and dates to plain text', async () => {
    // Mirrors real production shapes: ExcelJS returns { formula, result } for
    // formula cells and { richText: [...] } for rich-text cells, not plain
    // strings. A naive String(value) turns both into "[object Object]".
    const path = join(tmpDir, 'formula-values.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getCell('A1').value = 'strFormula';
    ws.getCell('B1').value = 'numFormula';
    ws.getCell('C1').value = 'richText';
    ws.getCell('D1').value = 'dateCell';
    ws.getCell('A2').value = { formula: 'A2', result: 'Arnett, Erin 072126.MP4' };
    ws.getCell('B2').value = { formula: 'SUM(1,2)', result: 42 };
    ws.getCell('C2').value = { richText: [{ text: 'Hello ' }, { text: 'World' }] };
    ws.getCell('D2').value = new Date('2026-01-15T00:00:00.000Z');
    await wb.xlsx.writeFile(path);

    const sheet = await readSheet(path);
    expect(sheet.rows[0]!.cells['strFormula']).toBe('Arnett, Erin 072126.MP4');
    expect(sheet.rows[0]!.cells['numFormula']).toBe('42');
    expect(sheet.rows[0]!.cells['richText']).toBe('Hello World');
    expect(sheet.rows[0]!.cells['dateCell']).toBe('2026-01-15');
  });

  it('throws a SheetError naming the cell when a formula evaluates to an Excel error', async () => {
    const path = join(tmpDir, 'formula-error.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getCell('A1').value = 'id';
    ws.getCell('B1').value = 'broken';
    ws.getCell('A2').value = 'row1';
    ws.getCell('B2').value = { formula: 'A1/0', result: { error: '#DIV/0!' } };
    await wb.xlsx.writeFile(path);

    await expect(readSheet(path)).rejects.toThrow(SheetError);
    await expect(readSheet(path)).rejects.toThrow(/B2/);
  });

  it('throws a SheetError naming the cell for a bare error value (not wrapped in a formula)', async () => {
    const path = join(tmpDir, 'bare-error.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getCell('A1').value = 'id';
    ws.getCell('B1').value = 'broken';
    ws.getCell('A2').value = 'row1';
    ws.getCell('B2').value = { error: '#REF!' };
    await wb.xlsx.writeFile(path);

    await expect(readSheet(path)).rejects.toThrow(SheetError);
    await expect(readSheet(path)).rejects.toThrow(/B2/);
  });
});

describe('readSheet (csv) — malformed rows', () => {
  it('rejects a data row with more fields than the header row', async () => {
    // The exact hazard this repo's own fixture exists to test: an unquoted
    // value containing a comma (e.g. "Birch ,Rowan") splits into extra
    // fields. If that's silently tolerated, the extra field shifts every
    // later column — landing metadata in the wrong xpath with no error.
    const tmpDir = await mkdtemp(join(tmpdir(), 'oeq-sheet-toolong-'));
    try {
      const path = join(tmpDir, 'too-long-row.csv');
      await writeFile(path, 'a,b\nx,y,z\n', 'utf8');
      await expect(readSheet(path)).rejects.toThrow(SheetError);
      await expect(readSheet(path)).rejects.toThrow(/record length/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('readSheet — interior blank rows keep their true row numbers', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oeq-sheet-blankrow-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('csv: a blank interior line does not shift later row numbers', async () => {
    const path = join(tmpDir, 'blank-interior.csv');
    await writeFile(path, 'h1,h2\nr2a,r2b\n\nr4a,r4b\n', 'utf8');

    const sheet = await readSheet(path);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]!.rowNumber).toBe(2);
    expect(sheet.rows[0]!.cells['h1']).toBe('r2a');
    expect(sheet.rows[1]!.rowNumber).toBe(4);
    expect(sheet.rows[1]!.cells['h1']).toBe('r4a');
  });

  it('xlsx: an untouched interior row does not shift later row numbers', async () => {
    const path = join(tmpDir, 'blank-interior.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getRow(1).values = ['h1', 'h2'];
    ws.getRow(2).values = ['r2a', 'r2b'];
    // row 3 is intentionally left completely untouched — no cell ever written.
    ws.getRow(4).values = ['r4a', 'r4b'];
    await wb.xlsx.writeFile(path);

    const sheet = await readSheet(path);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]!.rowNumber).toBe(2);
    expect(sheet.rows[0]!.cells['h1']).toBe('r2a');
    expect(sheet.rows[1]!.rowNumber).toBe(4);
    expect(sheet.rows[1]!.cells['h1']).toBe('r4a');
  });
});

describe('readSheet — duplicate column headers', () => {
  it('csv: throws a SheetError listing the duplicated header and its column positions', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'oeq-sheet-dupe-'));
    try {
      const path = join(tmpDir, 'dupe-headers.csv');
      await writeFile(path, 'a,b,a\nv1,v2,v3\n', 'utf8');
      await expect(readSheet(path)).rejects.toThrow(SheetError);
      await expect(readSheet(path)).rejects.toThrow(/'a'.*columns 1, 3/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
