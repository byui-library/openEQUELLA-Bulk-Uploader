import { describe, it, expect } from 'vitest';
import { applyOverrides, reportColumns, resolveSchemaPath } from '../../src/desktop/handlers.js';
import type { Sheet } from '../../src/core/types.js';

describe('applyOverrides', () => {
  const sheet: Sheet = {
    headers: ['Creator', 'Title', 'attachment name'],
    rows: [
      {
        rowNumber: 2,
        cells: { Creator: 'Ada Lovelace', Title: 'Notes', 'attachment name': 'a.mp4' },
      },
      {
        rowNumber: 3,
        cells: { Creator: 'Alan Turing', Title: 'Paper', 'attachment name': 'b.mp4' },
      },
    ],
  };

  it('returns the sheet unchanged (same reference) when there are no overrides', () => {
    expect(applyOverrides(sheet, {})).toBe(sheet);
  });

  it('remaps a single column in both headers and every row', () => {
    const result = applyOverrides(sheet, { Creator: 'MWDL/creator' });
    expect(result.headers).toEqual(['MWDL/creator', 'Title', 'attachment name']);
    expect(result.rows[0]!.cells).toEqual({
      'MWDL/creator': 'Ada Lovelace',
      Title: 'Notes',
      'attachment name': 'a.mp4',
    });
    expect(result.rows[1]!.cells).toEqual({
      'MWDL/creator': 'Alan Turing',
      Title: 'Paper',
      'attachment name': 'b.mp4',
    });
  });

  it('remaps several columns at once, consistently across headers and cells', () => {
    const result = applyOverrides(sheet, {
      Creator: 'MWDL/creator',
      Title: 'MWDL/title',
    });
    expect(result.headers).toEqual(['MWDL/creator', 'MWDL/title', 'attachment name']);
    for (const row of result.rows) {
      expect(Object.keys(row.cells).sort()).toEqual(
        ['MWDL/creator', 'MWDL/title', 'attachment name'].sort(),
      );
    }
    expect(result.rows[0]!.cells['MWDL/creator']).toBe('Ada Lovelace');
    expect(result.rows[0]!.cells['MWDL/title']).toBe('Notes');
  });

  it('leaves columns with no override untouched', () => {
    const result = applyOverrides(sheet, { Creator: 'MWDL/creator' });
    expect(result.headers).toContain('Title');
    expect(result.headers).toContain('attachment name');
    expect(result.rows[0]!.cells['Title']).toBe('Notes');
    expect(result.rows[0]!.cells['attachment name']).toBe('a.mp4');
  });

  it('keeps headers and every row cells-key set consistent (no drift)', () => {
    const result = applyOverrides(sheet, { Creator: 'MWDL/creator', Title: 'MWDL/title' });
    const headerSet = new Set(result.headers);
    for (const row of result.rows) {
      expect(new Set(Object.keys(row.cells))).toEqual(headerSet);
    }
  });

  it('does not mutate the original sheet', () => {
    const before = JSON.parse(JSON.stringify(sheet));
    applyOverrides(sheet, { Creator: 'MWDL/creator' });
    expect(sheet).toEqual(before);
  });

  it('an override key that does not match any header is harmless', () => {
    const result = applyOverrides(sheet, { NoSuchColumn: 'MWDL/whatever' });
    expect(result.headers).toEqual(sheet.headers);
  });
});

describe('reportColumns', () => {
  // 'attachment name' is valid via schema.ts's own RESERVED set, independent
  // of what's in `paths` -- included here to also cover that a valid header
  // never carries suggestions regardless of why it's valid.
  const paths = new Set(['MWDL/title', 'MWDL/identifier']);

  it('a valid header comes back with an empty suggestions list', () => {
    const [report] = reportColumns(['MWDL/title'], paths);
    expect(report).toEqual({ header: 'MWDL/title', valid: true, suggestions: [] });
  });

  it('the reserved attachment-name column is valid with no suggestions', () => {
    const [report] = reportColumns(['attachment name'], paths);
    expect(report).toEqual({ header: 'attachment name', valid: true, suggestions: [] });
  });

  it('an invalid header comes back with a non-empty suggestions list', () => {
    // One edit away from 'MWDL/title' -- close enough that schema.ts's
    // `suggest()` is expected to surface it.
    const [report] = reportColumns(['MWDL/titel'], paths);
    expect(report!.valid).toBe(false);
    expect(report!.suggestions.length).toBeGreaterThan(0);
    expect(report!.suggestions).toContain('MWDL/title');
  });

  it('an invalid header with no plausible match still comes back with an empty list, never a crash', () => {
    const [report] = reportColumns(['Completely Unrelated Nonsense'], paths);
    expect(report!.valid).toBe(false);
    expect(report!.suggestions).toEqual([]);
  });

  it('reports each header independently in a mixed set', () => {
    const result = reportColumns(['MWDL/title', 'Some Bogus Header', 'attachment name'], paths);
    expect(result).toEqual([
      { header: 'MWDL/title', valid: true, suggestions: [] },
      { header: 'Some Bogus Header', valid: false, suggestions: [] },
      { header: 'attachment name', valid: true, suggestions: [] },
    ]);
  });
});

describe('resolveSchemaPath', () => {
  it('resolves under the app path when unpackaged (development)', () => {
    const p = resolveSchemaPath({
      isPackaged: false,
      appPath: 'C:\\repo',
      resourcesPath: 'C:\\repo\\dist-desktop',
    });
    expect(p.replace(/\\/g, '/')).toBe('C:/repo/schema/_entity.xml');
  });

  it('resolves under resourcesPath when packaged, ignoring appPath', () => {
    const p = resolveSchemaPath({
      isPackaged: true,
      appPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\app\\resources\\app.asar',
      resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\app\\resources',
    });
    expect(p.replace(/\\/g, '/')).toBe(
      'C:/Users/me/AppData/Local/Programs/app/resources/schema/_entity.xml',
    );
  });
});
