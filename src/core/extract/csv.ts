// src/core/extract/csv.ts
import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { guardFormula } from '../formulaGuard.js';
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

  // A composeOnly column exists so another column can read it, and must never
  // reach the spreadsheet -- that is the whole reason it exists instead of an
  // ordinary column pointed at a schema field that means something else.
  const columns = profile.columns.filter((c) => !c.composeOnly);

  const headers = [...columns.map((c) => c.path), SOURCE_COLUMN, NOTES_COLUMN];
  sheet.addRow(headers);

  for (const row of rows) {
    const sources = Object.entries(row.sources)
      .map(([path, kind]) => `${path}=${kind}`)
      .join('; ');
    // Guarded because this file is opened in Excel, which executes a cell that
    // begins `=`, `+`, `-` or `@` -- and these values came out of documents
    // nobody vetted. The annotation columns get it too: `_notes` quotes
    // discarded model output, which is exactly as attacker-influenced as a
    // description. `src/core/sheet.ts` removes the guard when the spreadsheet
    // is read back, so what reaches openEQUELLA is what the document said.
    //
    // HEADERS ARE DELIBERATELY NOT GUARDED. They are schema xpaths and the two
    // `_`-prefixed annotation names, none of which can begin with a trigger --
    // and guarding one would stop `plan` matching the column at all.
    sheet.addRow([
      ...columns.map((c) => guardFormula(row.cells[c.path] ?? '')),
      guardFormula(sources),
      guardFormula(row.notes.join('; ')),
    ]);
  }

  // Written through a buffer so a UTF-8 byte-order mark can go in front.
  //
  // Excel decides a CSV's encoding from its first bytes. Without a BOM it
  // assumes the system codepage, so "Ibáñez" is displayed as "IbÃ¡Ã±ez" and an
  // em dash as "â". The bytes were always correct UTF-8 -- Excel was reading
  // them wrongly -- but this feature's entire promise is "open it in Excel and
  // check it", and a spreadsheet full of apparent corruption fails that. Worse,
  // someone might repair the display in Excel and save, which corrupts the data
  // for real.
  //
  // src/core/sheet.ts passes `bom: true` to csv-parse so the mark never reaches
  // the first column name. That matters: a BOM corrupts the FIRST field only,
  // which is how it once broke .env parsing here in a thoroughly confusing way.
  const body = await workbook.csv.writeBuffer();
  await writeFile(path, Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(body as ArrayBuffer)]));
}
