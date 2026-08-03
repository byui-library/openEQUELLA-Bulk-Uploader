import { describe, it, expect } from 'vitest';
import { readSheet } from '../src/core/sheet.js';

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
