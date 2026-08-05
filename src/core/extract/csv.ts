// src/core/extract/csv.ts
import ExcelJS from 'exceljs';
import type { ExtractedRow, Profile } from './types.js';

/** Where each value came from. Underscore-prefixed, so the uploader ignores it. */
export const SOURCE_COLUMN = '_source';
/** Problems with this row. Underscore-prefixed, so the uploader ignores it. */
export const NOTES_COLUMN = '_notes';

/**
 * Serialise rows to CSV.
 *
 * Written through exceljs rather than by hand. Correct quoting is the whole
 * job of a CSV writer, and this project has already been bitten once by a
 * malformed row silently shifting every later column into the wrong xpath --
 * see the relax_column_count_less comment in src/core/sheet.ts. Getting that
 * wrong in the writer would produce the same class of failure.
 */
export async function writeCsv(path: string, profile: Profile, rows: ExtractedRow[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('extracted');

  const headers = [...profile.columns.map((c) => c.path), SOURCE_COLUMN, NOTES_COLUMN];
  sheet.addRow(headers);

  for (const row of rows) {
    const sources = Object.entries(row.sources)
      .map(([path, kind]) => `${path}=${kind}`)
      .join('; ');
    sheet.addRow([
      ...profile.columns.map((c) => row.cells[c.path] ?? ''),
      sources,
      row.notes.join('; '),
    ]);
  }

  await workbook.csv.writeFile(path);
}
