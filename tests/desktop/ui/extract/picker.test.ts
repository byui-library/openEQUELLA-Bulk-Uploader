// tests/desktop/ui/extract/picker.test.ts
import { describe, it, expect } from 'vitest';
import { availablePaths, plainLabel } from '../../../../src/desktop/ui/extract/picker.js';

const all = ['MWDL/title', 'MWDL/date', 'MWDL/creators/creator', 'MWDL/rights/description'];

describe('availablePaths', () => {
  it('excludes paths already used by a column', () => {
    expect(availablePaths(all, ['MWDL/title'], '')).toEqual([
      'MWDL/creators/creator', 'MWDL/date', 'MWDL/rights/description',
    ]);
  });

  it('filters case-insensitively on any part of the path', () => {
    expect(availablePaths(all, [], 'creat')).toEqual(['MWDL/creators/creator']);
    expect(availablePaths(all, [], 'TITLE')).toEqual(['MWDL/title']);
  });

  it('returns everything unused when the query is blank', () => {
    expect(availablePaths(all, [], '   ')).toHaveLength(4);
  });

  it('returns nothing when the query matches nothing', () => {
    expect(availablePaths(all, [], 'zzz')).toEqual([]);
  });
});

describe('plainLabel', () => {
  it('uses the last path segment, spaced and capitalised', () => {
    expect(plainLabel('MWDL/title')).toBe('Title');
    expect(plainLabel('MWDL/creators/creator')).toBe('Creator');
    expect(plainLabel('BYUI_extended/BYUI_information/go_live_date/status')).toBe('Status');
  });

  it('splits camelCase into words', () => {
    expect(plainLabel('MWDL/alternativeTitles/alternativeTitle')).toBe('Alternative title');
  });

  it('leaves a reserved column alone', () => {
    expect(plainLabel('attachment name')).toBe('Attachment name');
  });
});
