import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import type { Row, Sheet } from './types.js';
import { SheetError } from './errors.js';

/** A row of raw cell text, tagged with its true 1-based position in the source spreadsheet. */
interface RawRow {
  rowNumber: number;
  values: string[];
}

/** Throw if any header appears more than once — silently colliding into one column would lose data. */
function assertNoDuplicateHeaders(headers: string[]): void {
  const columnsByHeader = new Map<string, number[]>();
  headers.forEach((h, i) => {
    const cols = columnsByHeader.get(h) ?? [];
    cols.push(i + 1);
    columnsByHeader.set(h, cols);
  });
  const duplicates = [...columnsByHeader.entries()].filter(([, cols]) => cols.length > 1);
  if (duplicates.length > 0) {
    const desc = duplicates
      .map(([h, cols]) => `'${h}' (columns ${cols.join(', ')})`)
      .join('; ');
    throw new SheetError(`Duplicate column headers: ${desc}`);
  }
}

/** Build a Sheet from a header array and raw rows, each already carrying its true source row number. */
function toSheet(headers: string[], raw: RawRow[]): Sheet {
  assertNoDuplicateHeaders(headers);
  const rows: Row[] = raw.map(({ rowNumber, values }) => {
    const cells: Record<string, string> = {};
    headers.forEach((h, col) => {
      cells[h] = (values[col] ?? '').trim();
    });
    return { rowNumber, cells };
  });
  return { headers, rows };
}

/** Drop rows where every cell is blank — spreadsheets accumulate these — while preserving surviving rows' true row numbers. */
function dropEmptyRows(raw: RawRow[]): RawRow[] {
  return raw.filter(({ values }) => values.some((c) => (c ?? '').trim() !== ''));
}

async function readCsv(path: string): Promise<Sheet> {
  const text = await readFile(path, 'utf8');
  // skipEmptyLines is deliberately off: it drops blank lines before we ever
  // see them, which would silently shift every later row's number. We tag
  // rows with their true position ourselves and filter blanks afterward.
  // relax_column_count_less tolerates the resulting short rows (e.g. a blank
  // line parses to a single empty field) without also relaxing the *more*
  // side: a row with too many fields — e.g. an unquoted value containing a
  // comma, the exact hazard this tool's own fixture exists to test — must
  // still throw, or the extra field silently shifts every column after it
  // into the wrong xpath.
  let records: string[][];
  try {
    records = parse(text, {
      skipEmptyLines: false,
      relax_column_count_less: true,
      // Explicit rather than relying on the library's default. Spreadsheets
      // saved from Excel routinely start with a UTF-8 byte-order mark, and the
      // extractor now writes one deliberately so Excel reads accents correctly.
      // An unskipped mark corrupts the FIRST column name and nothing else,
      // which reads as "this one header is mysteriously invalid" -- the same
      // shape as the .env BOM problem this project has already been bitten by.
      bom: true,
    }) as string[][];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SheetError(`${path}: ${message}`);
  }
  const headers = (records[0] ?? []).map((h) => h.trim());
  if (headers.length === 0) throw new SheetError(`${path} has no header row`);
  const raw: RawRow[] = records.slice(1).map((values, i) => ({ rowNumber: i + 2, values }));
  return toSheet(headers, dropEmptyRows(raw));
}

/** Excel column index (1-based) to letters, e.g. 1 -> 'A', 28 -> 'AB'. */
function columnLetters(col: number): string {
  let n = col;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellRef(rowNumber: number, col: number): string {
  return `${columnLetters(col)}${rowNumber}`;
}

/**
 * Render an ExcelJS cell value as plain text.
 *
 * Cells are usually a string/number/boolean, but ExcelJS returns objects for
 * several shapes real workbooks use: formula cells come back as
 * `{ formula, result }` (or `{ sharedFormula, result }`), rich-text cells as
 * `{ richText: [...] }`, hyperlinks as `{ text, hyperlink }`, and dates as a
 * genuine `Date`. A naive `String(value)` turns the object shapes into
 * `"[object Object]"` — silently corrupting every formula-driven column,
 * which is exactly how production spreadsheets author `attachment name` and
 * `MWDL/title` (e.g. `=CONCATENATE(...)`).
 *
 * `ref` is an Excel-style cell reference (e.g. "C2") used only for error
 * messages, so a user can find the offending cell.
 */
function cellText(value: ExcelJS.CellValue, ref: string): string {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if ('result' in value) {
    const result = value.result;
    if (result != null && typeof result === 'object' && 'error' in result) {
      throw new SheetError(
        `Cell ${ref} contains a formula error (${result.error}); fix the formula before uploading.`,
      );
    }
    return cellText(result, ref);
  }
  if ('richText' in value) {
    return value.richText.map((r) => r.text).join('');
  }
  if ('text' in value) {
    return value.text;
  }
  if ('error' in value) {
    throw new SheetError(`Cell ${ref} contains an error value (${value.error}); fix it before uploading.`);
  }
  throw new SheetError(`Cell ${ref} has an unsupported value shape: ${JSON.stringify(value)}`);
}

async function readXlsx(path: string): Promise<Sheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  if (!ws) throw new SheetError(`${path} contains no worksheets`);

  const raw: RawRow[] = [];
  let headers: string[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    // ExcelJS row.values is 1-indexed with a leading hole at index 0.
    const cells = row.values as ExcelJS.CellValue[];
    const values: string[] = [];
    for (let i = 1; i < cells.length; i++) {
      values.push(cellText(cells[i], cellRef(rowNumber, i)));
    }
    if (rowNumber === 1) {
      headers = values.map((h) => h.trim());
    } else {
      // Use the row's true position from eachRow, not its index in this
      // array — eachRow silently omits untouched rows, so array position
      // alone would compact away any gap and mislabel every later row.
      raw.push({ rowNumber, values });
    }
  });

  if (headers.length === 0) throw new SheetError(`${path} has no header row`);
  return toSheet(headers, dropEmptyRows(raw));
}

export async function readSheet(path: string): Promise<Sheet> {
  const ext = extname(path).toLowerCase();
  if (ext === '.csv') return readCsv(path);
  if (ext === '.xlsx' || ext === '.xls') return readXlsx(path);
  throw new SheetError(`Unsupported spreadsheet type '${ext}'. Use .xlsx or .csv.`);
}
