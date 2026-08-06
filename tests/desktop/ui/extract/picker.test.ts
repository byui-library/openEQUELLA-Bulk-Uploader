// tests/desktop/ui/extract/picker.test.ts
import { describe, it, expect } from 'vitest';
import { availablePaths, groupPaths, plainLabel } from '../../../../src/desktop/ui/extract/picker.js';

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

// The schema holds 158 leaf paths: 98 under BYUI_extended, 34 under MWDL, and
// the rest scattered. Sorted plainly, every BYUI_extended path came first and
// MWDL was 98 rows down, past a 50-row cap -- so the fields people actually
// need (title, creator, date) could not be reached by scrolling at all.
// Found by an operator on the real screen.
describe('availablePaths ordering', () => {
  const mixed = [
    'BYUI_extended/av/poster',
    'MWDL/title',
    'item/name',
    'BYUI_extended/athletics/event',
    'MWDL/creators/creator',
    'HBCS/subject',
  ];

  it('puts MWDL first, then BYUI_extended, then everything else', () => {
    expect(availablePaths(mixed, [], '')).toEqual([
      'MWDL/creators/creator',
      'MWDL/title',
      'BYUI_extended/athletics/event',
      'BYUI_extended/av/poster',
      'HBCS/subject',
      'item/name',
    ]);
  });

  it('still sorts alphabetically inside each group', () => {
    const paths = availablePaths(['MWDL/title', 'MWDL/date', 'MWDL/creators/creator'], [], '');
    expect(paths).toEqual(['MWDL/creators/creator', 'MWDL/date', 'MWDL/title']);
  });

  it('keeps the group order when a search narrows the list', () => {
    expect(availablePaths(mixed, [], 'e')).toEqual([
      'MWDL/creators/creator',
      'MWDL/title',
      'BYUI_extended/athletics/event',
      'BYUI_extended/av/poster',
      'HBCS/subject',
      'item/name',
    ]);
  });
});

describe('groupPaths', () => {
  it('groups by the top-level schema name, preserving the given order', () => {
    expect(groupPaths(['MWDL/title', 'MWDL/date', 'BYUI_extended/av/poster'])).toEqual([
      { schema: 'MWDL', paths: ['MWDL/title', 'MWDL/date'] },
      { schema: 'BYUI_extended', paths: ['BYUI_extended/av/poster'] },
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupPaths([])).toEqual([]);
  });

  it('handles a path with no slash', () => {
    expect(groupPaths(['attachment name'])).toEqual([
      { schema: 'attachment name', paths: ['attachment name'] },
    ]);
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
