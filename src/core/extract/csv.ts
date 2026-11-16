// src/core/extract/csv.ts
import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { guardFormula } from '../formulaGuard.js';
import type { ExtractedRow, FolderProblem, Profile } from './types.js';

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

/**
 * Where the problems log for a spreadsheet goes: beside it, named after it.
 * `sre.csv` -> `sre-problems.csv`. Beside the spreadsheet on both surfaces,
 * because that is the folder the operator is already working in.
 */
export function problemsPathFor(spreadsheetPath: string): string {
  return `${spreadsheetPath.replace(/\.csv$/i, '')}-problems.csv`;
}

/**
 * The problems log of a one-row-per-subfolder build: every folder left out of
 * the spreadsheet and every note worth a look, one line each.
 *
 * WRITTEN EVERY TIME, header alone when there is nothing to say. A log left
 * over from an earlier build would describe folders that have since been
 * fixed, and an operator has no way to tell a stale log from a current one.
 *
 * Guarded like the spreadsheet: the file names and folder names in it came
 * off a disk nobody vetted, and Excel executes a cell that begins `=`.
 */
export async function writeProblemsCsv(path: string, problems: readonly FolderProblem[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('problems');
  sheet.addRow(['folder', 'file', 'effect', 'problem', 'what to do']);
  for (const p of problems) {
    sheet.addRow([p.folder, p.file, p.effect, p.problem, p.fix].map(guardFormula));
  }
  const body = await workbook.csv.writeBuffer();
  // The same byte-order mark as writeCsv, for the same reason: Excel reads
  // a CSV without one in the system codepage and mangles every accent.
  await writeFile(path, Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(body as ArrayBuffer)]));
}

/**
 * What a problems log holds, as both surfaces report it: FOLDERS held back
 * (a folder with two problems is one folder left out) and note lines. One
 * count, so the CLI and the desktop cannot tell an operator different numbers.
 */
export function countProblems(problems: readonly FolderProblem[]): { heldBack: number; notes: number } {
  const held = problems.filter((p) => p.effect === 'held back');
  return {
    // Folders only: a loose file beside them is listed in the log, but it is
    // not a folder, and "N folder(s) held back" must count what it says.
    heldBack: new Set(held.filter((p) => p.folder !== '').map((p) => p.folder)).size,
    notes: problems.length - held.length,
  };
}
