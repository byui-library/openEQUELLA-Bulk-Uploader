// tests/desktop/ui/previewNotes.test.ts
import { describe, it, expect } from 'vitest';
import { previewNotes } from '../../../src/desktop/ui/screens/extractColumns.js';
import type { ExtractedRow } from '../../../src/core/extract/types.js';

const row = (fileName: string, notes: string[]): ExtractedRow => ({
  cells: { 'attachment name': fileName },
  sources: {},
  notes,
});

/**
 * The preview used to report only a COUNT of flagged rows, so the operator had
 * to save the spreadsheet and open it in Excel to learn which row was flagged
 * and why. This whole feature rests on being flagged rather than silent, and
 * the flag was invisible at the moment of decision.
 */
describe('previewNotes', () => {
  it('renders nothing when no row is flagged', () => {
    expect(previewNotes([row('a.pdf', []), row('b.pdf', [])])).toBe('');
  });

  it('names the file a note belongs to', () => {
    expect(previewNotes([row('Brandon Lythoe Obituary.pdf', ['no date found'])])).toContain(
      'Brandon Lythoe Obituary.pdf',
    );
  });

  it('shows the note itself, not just that there is one', () => {
    expect(previewNotes([row('a.pdf', ['no date found'])])).toContain('no date found');
  });

  it('shows every note a row carries', () => {
    const html = previewNotes([row('a.pdf', ['first thing', 'second thing'])]);
    expect(html).toContain('first thing');
    expect(html).toContain('second thing');
  });

  it('lists several flagged rows', () => {
    const html = previewNotes([row('a.pdf', ['x']), row('b.pdf', []), row('c.pdf', ['y'])]);
    expect(html).toContain('a.pdf');
    expect(html).toContain('c.pdf');
    expect(html).not.toContain('b.pdf');
  });

  /**
   * A filename comes from disk and a note quotes it. Neither is trustworthy
   * input for a template assigned to innerHTML.
   */
  it('escapes the filename', () => {
    const html = previewNotes([row('<img src=x onerror=alert(1)>.pdf', ['x'])]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('escapes the note text', () => {
    const html = previewNotes([row('a.pdf', ['<script>bad()</script>'])]);
    expect(html).not.toContain('<script>');
  });

  it('copes with a row whose filename cell is missing', () => {
    const orphan: ExtractedRow = { cells: {}, sources: {}, notes: ['x'] };
    expect(() => previewNotes([orphan])).not.toThrow();
    expect(previewNotes([orphan])).toContain('x');
  });
});
