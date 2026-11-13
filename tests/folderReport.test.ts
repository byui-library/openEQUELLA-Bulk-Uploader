import { describe, it, expect } from 'vitest';
import { folderLines, planFolders } from '../src/core/folderReport.js';
import { fileEntry } from './helpers/entry.js';

describe('folderLines', () => {
  it('lists each folder row, numbered in upload order, with its skipped files', () => {
    const folderRow = {
      ...fileEntry(3, '', ''),
      source: 'Gazette_V2',
      folderPath: '/b/Gazette_V2',
      files: [
        { path: '/b/Gazette_V2/G_No1.pdf', name: 'G_No1.pdf' },
        { path: '/b/Gazette_V2/G_No2.pdf', name: 'G_No2.pdf' },
      ],
      skippedFiles: [{ name: 'Thumbs.db', reason: 'a Windows thumbnail cache' }],
    };
    expect(folderLines([fileEntry(2, '/b/x.pdf', 'x.pdf'), folderRow])).toEqual([
      'Row 3: Gazette_V2 (2 files), in upload order:',
      '    1. G_No1.pdf',
      '    2. G_No2.pdf',
      '    not uploaded: Thumbs.db (a Windows thumbnail cache)',
    ]);
  });

  it('says nothing for a file-only batch', () => {
    expect(folderLines([fileEntry(2, '/b/x.pdf', 'x.pdf')])).toEqual([]);
  });
});

describe('planFolders', () => {
  it('gives the desktop each folder row: label, files in order, skipped', () => {
    const folderRow = {
      ...fileEntry(3, '', ''),
      source: 'Gazette_V2',
      folderPath: '/b/Gazette_V2',
      files: [
        { path: '/b/Gazette_V2/G_No1.pdf', name: 'G_No1.pdf' },
        { path: '/b/Gazette_V2/G_No2.pdf', name: 'G_No2.pdf' },
      ],
    };
    expect(planFolders([fileEntry(2, '/b/x.pdf', 'x.pdf'), folderRow])).toEqual([
      { rowNumber: 3, label: 'Gazette_V2 (2 files)', files: ['G_No1.pdf', 'G_No2.pdf'], skipped: [] },
    ]);
  });
});
