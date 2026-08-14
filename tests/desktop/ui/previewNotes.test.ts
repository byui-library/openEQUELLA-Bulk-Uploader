// tests/desktop/ui/previewNotes.test.ts
import { describe, it, expect } from 'vitest';
import { previewNotes, previewReviewCount } from '../../../src/desktop/ui/screens/extractColumns.js';
import type { ExtractedRow } from '../../../src/core/extract/types.js';

const row = (fileName: string, notes: string[]): ExtractedRow => ({
  cells: { 'attachment name': fileName },
  sources: {},
  notes,
  flagged: {},
  aiWritten: {},
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
    expect(previewNotes([row('Alden Larkspar Obituary.pdf', ['no date found'])])).toContain(
      'Alden Larkspar Obituary.pdf',
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
    const orphan: ExtractedRow = {
      cells: {},
      sources: {},
      notes: ['x'],
      flagged: {},
      aiWritten: {},
    };
    expect(() => previewNotes([orphan])).not.toThrow();
    expect(previewNotes([orphan])).toContain('x');
  });
});

/**
 * ## The same counter problem, on the other surface a reviewer flagged
 *
 * `previewTable`'s heading counts rows with any note at all, exactly as
 * `extractHandlers` did. The preview does not run the model pass today -- it
 * re-renders on every keystroke, and a paid call per keystroke is not a feature
 * -- so `aiWritten` is empty here in practice. The subtraction is applied all
 * the same, because the alternative is a screen that reads "5 need review" the
 * day anything hands it a model-written row, which is precisely how this
 * failure arrived on the other surface.
 *
 * WHAT IS NOT SUBTRACTED IS THE LIST. `previewNotes` keeps showing every row
 * that carries any note, including a model write, because the flag on a
 * model-written cell is the whole safety argument of the feature and hiding it
 * at the moment of decision would be worse than miscounting.
 */
describe('the preview heading and a row a model wrote', () => {
  const AI_NOTE = 'MWDL/description: written by a language model from the document text.';

  const written = (fileName: string): ExtractedRow => ({
    cells: { 'attachment name': fileName },
    sources: {},
    notes: [AI_NOTE],
    flagged: {},
    aiWritten: { 'MWDL/description': { note: AI_NOTE, factField: false } },
  });

  it('does not count a model write among the rows needing review', () => {
    expect(previewReviewCount([written('a.pdf'), row('b.pdf', [])])).toBe(0);
  });

  it('still counts a genuine problem on a row a model also wrote', () => {
    const r = written('a.pdf');
    r.notes.push('this file has no text layer');
    expect(previewReviewCount([r])).toBe(1);
  });

  it('counts an ordinary flagged row as it always did', () => {
    expect(previewReviewCount([row('a.pdf', ['no date found']), row('b.pdf', [])])).toBe(1);
  });

  /** The flag itself stays visible. It is the reason the feature is allowed to
   *  write into a permanent catalogue at all. */
  it('still shows the model note in the list', () => {
    expect(previewNotes([written('a.pdf')])).toContain('written by a language model');
  });
});
