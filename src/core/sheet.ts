import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import type { Row, Sheet } from './types.js';
import { SheetError } from './errors.js';

/** Build a Sheet from a header array and an array of raw string rows. */
function toSheet(headers: string[], raw: string[][]): Sheet {
  const rows: Row[] = raw.map((values, i) => {
    const cells: Record<string, string> = {};
    headers.forEach((h, col) => {
      cells[h] = (values[col] ?? '').trim();
    });
    return { rowNumber: i + 2, cells };
  });
  return { headers, rows };
}

/** Drop trailing rows where every cell is blank — spreadsheets accumulate these. */
function dropEmptyRows(raw: string[][]): string[][] {
  return raw.filter((r) => r.some((c) => (c ?? '').trim() !== ''));
}

async function readCsv(path: string): Promise<Sheet> {
  const text = await readFile(path, 'utf8');
  const records = parse(text, { skipEmptyLines: true }) as string[][];
  const headers = (records[0] ?? []).map((h) => h.trim());
  if (headers.length === 0) throw new SheetError(`${path} has no header row`);
  return toSheet(headers, dropEmptyRows(records.slice(1)));
}

/**
 * Render an ExcelJS cell value as plain text. Cells are usually a
 * string/number/Date, but rich-text and hyperlink cells come back as
 * objects; hyperlink cells carry their display text on `.text`.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'object' && 'text' in value) {
    return value.text;
  }
  return String(value);
}

async function readXlsx(path: string): Promise<Sheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  if (!ws) throw new SheetError(`${path} contains no worksheets`);

  const raw: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    // ExcelJS row.values is 1-indexed with a leading hole at index 0.
    const cells = row.values as ExcelJS.CellValue[];
    for (let i = 1; i < cells.length; i++) {
      values.push(cellText(cells[i]));
    }
    raw.push(values);
  });

  const headers = (raw[0] ?? []).map((h) => h.trim());
  if (headers.length === 0) throw new SheetError(`${path} has no header row`);
  return toSheet(headers, dropEmptyRows(raw.slice(1)));
}

export async function readSheet(path: string): Promise<Sheet> {
  const ext = extname(path).toLowerCase();
  if (ext === '.csv') return readCsv(path);
  if (ext === '.xlsx' || ext === '.xls') return readXlsx(path);
  throw new SheetError(`Unsupported spreadsheet type '${ext}'. Use .xlsx or .csv.`);
}
