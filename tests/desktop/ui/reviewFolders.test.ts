import { describe, it, expect } from 'vitest';
import { foldersSection, moveFile } from '../../../src/desktop/ui/screens/review.js';

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
    expect(html.indexOf('<li>G_No1.pdf')).toBeGreaterThan(-1);
    expect(html.indexOf('<li>G_No1.pdf')).toBeLessThan(html.indexOf('<li>G_No2.pdf'));
    expect(html).toMatch(/<ol>/);
    expect(html).toContain('Thumbs.db (a Windows thumbnail cache)');
  });

  it('tells the operator how to change the order: the order column', () => {
    expect(foldersSection([folder])).toContain('Use the arrows');
    expect(foldersSection([folder])).toContain('<code>attachment order</code> cell');
  });

  it('escapes names, and carries no inline style -- the CSP would drop it', () => {
    const html = foldersSection([{ ...folder, files: ['<img src=x onerror=alert(1)>.pdf'] }]);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/style\s*=/);
  });
});

describe('foldersSection -- reordering in the app', () => {
  const three = { ...folder, files: ['No1.pdf', 'No2.pdf', 'No3.pdf'] };

  it('offers up and down for each file, but not past either end', () => {
    const html = foldersSection([three]);
    expect(html).toMatch(/id="order-up-2-0"[^>]*disabled/);
    expect(html).not.toMatch(/id="order-up-2-1"[^>]*disabled/);
    expect(html).toMatch(/id="order-down-2-2"[^>]*disabled/);
    expect(html).toContain('aria-label="Move No2.pdf up"');
  });

  it('shows the order chosen here, marks it, and offers to put it back', () => {
    const html = foldersSection([three], { 2: ['No3.pdf', 'No1.pdf', 'No2.pdf'] });
    expect(html.indexOf('No3.pdf')).toBeLessThan(html.indexOf('No1.pdf'));
    expect(html).toContain('order changed here');
    expect(html).toContain('id="order-reset-2"');
  });

  it('offers no reset while the order is the planned one', () => {
    expect(foldersSection([three])).not.toContain('order-reset-2');
  });
});

describe('moveFile', () => {
  it('moves one file one place, and leaves the original alone', () => {
    const files = ['a', 'b', 'c'];
    expect(moveFile(files, 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveFile(files, 1, 1)).toEqual(['a', 'c', 'b']);
    expect(files).toEqual(['a', 'b', 'c']);
  });
  it('does nothing past either end', () => {
    expect(moveFile(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveFile(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});
