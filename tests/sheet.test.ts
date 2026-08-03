import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
