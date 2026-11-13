import { describe, it, expect } from 'vitest';
import { foldersSection } from '../../../src/desktop/ui/screens/review.js';

const folder = {
  rowNumber: 2,
  label: 'Gazette_V2 (2 files)',
  files: ['G_No1.pdf', 'G_No2.pdf'],
  skipped: [{ name: 'Thumbs.db', reason: 'a Windows thumbnail cache' }],
};

describe('foldersSection', () => {
  it('renders nothing for a file-only batch', () => {
    expect(foldersSection([])).toBe('');
  });

  it('lists each folder\'s files in upload order, and what is not uploaded', () => {
    const html = foldersSection([folder]);
    expect(html).toContain('Folders: files in upload order (1)');
    expect(html).toContain('Row 2: Gazette_V2 (2 files)');
    expect(html.indexOf('<li>G_No1.pdf</li>')).toBeLessThan(html.indexOf('<li>G_No2.pdf</li>'));
    expect(html).toMatch(/<ol>/);
    expect(html).toContain('Thumbs.db (a Windows thumbnail cache)');
  });

  it('tells the operator how to change the order', () => {
    expect(foldersSection([folder])).toContain('rename the files');
  });

  it('escapes names, and carries no inline style -- the CSP would drop it', () => {
    const html = foldersSection([{ ...folder, files: ['<img src=x onerror=alert(1)>.pdf'] }]);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/style\s*=/);
  });
});
