// tests/extract/endToEnd.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFolder } from '../../src/core/extract/extract.js';
import { writeCsv } from '../../src/core/extract/csv.js';
import { parseProfile } from '../../src/core/extract/profile.js';
import { readSheet } from '../../src/core/sheet.js';
import { ATTACHMENT_COLUMN } from '../../src/core/extract/types.js';
import { makePdf, makeDocx } from '../fixtures/extract/make.js';

describe('extract end to end', () => {
  it('turns a folder of real files into a spreadsheet this tool can read back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-e2e-'));

    await writeFile(
      join(dir, 'Birch_Rowan_Recital_2026-04-12.pdf'),
      makePdf({ text: 'Instrument: Violin', title: 'ignored, filename wins' }),
    );
    await writeFile(
      join(dir, 'Ash_Quinn_Jury_2026-04-13.docx'),
      makeDocx({ text: 'Instrument: Cello', creator: 'ignored, filename wins' }),
    );
    // A scan: no text layer, but a usable filename and a real property.
    await writeFile(join(dir, 'Cedar_Sam_Recital_2026-04-14.pdf'), makePdf({ title: 'Scanned' }));

    // {ext} absorbs the extension, so one pattern covers both .pdf and .docx.
    // Without it, {date} would capture "2026-04-12.pdf" and the date transform
    // would refuse it -- correctly, but uselessly.
    const profile = parseProfile({
      version: 1,
      pattern: '{last}_{first}_{title}_{date}.{ext}',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
        { path: 'MWDL/creators/creator', sources: [{ join: '{last}, {first}' }] },
        { path: 'MWDL/date', sources: [{ placeholder: 'date' }], transform: 'date' },
        { path: 'MWDL/subject', sources: [{ label: 'Instrument' }] },
        { path: 'MWDL/publisher', sources: [], default: 'BYU-Idaho' },
      ],
    });

    const result = await extractFolder(dir, profile);
    expect(result.skipped).toEqual([]);
    expect(result.rows).toHaveLength(3);

    const out = join(dir, 'extracted.csv');
    await writeCsv(out, profile, result.rows);

    const sheet = await readSheet(out);
    expect(sheet.rows).toHaveLength(3);

    const byFile = new Map(sheet.rows.map((r) => [r.cells[ATTACHMENT_COLUMN], r.cells]));

    const pdf = byFile.get('Birch_Rowan_Recital_2026-04-12.pdf')!;
    expect(pdf['MWDL/title']).toBe('Recital');
    expect(pdf['MWDL/creators/creator']).toBe('Birch, Rowan');
    expect(pdf['MWDL/date']).toBe('2026-04-12');
    expect(pdf['MWDL/subject']).toBe('Violin');
    expect(pdf['MWDL/publisher']).toBe('BYU-Idaho');

    const docx = byFile.get('Ash_Quinn_Jury_2026-04-13.docx')!;
    expect(docx['MWDL/creators/creator']).toBe('Ash, Quinn');
    expect(docx['MWDL/subject']).toBe('Cello');

    // The scan: filename data survives, the label lookup finds nothing, and
    // the row says why rather than vanishing.
    const scan = byFile.get('Cedar_Sam_Recital_2026-04-14.pdf')!;
    expect(scan['MWDL/title']).toBe('Recital');
    expect(scan['MWDL/subject']).toBe('');
    expect(scan['_notes']).toMatch(/no text layer/i);
  });
});
