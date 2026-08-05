// tests/extract/pattern.test.ts
import { describe, it, expect } from 'vitest';
import { placeholders, applyPattern } from '../../src/core/extract/pattern.js';

describe('placeholders', () => {
  it('lists the placeholder names in order', () => {
    expect(placeholders('{last}_{first}_{title}.pdf')).toEqual(['last', 'first', 'title']);
  });

  it('returns an empty list when there are none', () => {
    expect(placeholders('report.pdf')).toEqual([]);
  });

  it('rejects a duplicated placeholder', () => {
    expect(() => placeholders('{a}_{a}.pdf')).toThrow(/duplicate/i);
  });
});

describe('applyPattern', () => {
  it('extracts each placeholder', () => {
    expect(applyPattern('{last}_{first}_{title}_{date}.pdf', 'Smith_Jane_Recital_2026-04-12.pdf'))
      .toEqual({ last: 'Smith', first: 'Jane', title: 'Recital', date: '2026-04-12' });
  });

  it('returns null when the filename does not match', () => {
    expect(applyPattern('{last}_{first}.pdf', 'nosuchseparator.pdf')).toBeNull();
  });

  it('is case-insensitive about the extension', () => {
    expect(applyPattern('{name}.pdf', 'Report.PDF')).toEqual({ name: 'Report' });
  });

  it('treats regex metacharacters in the literal parts as literals', () => {
    expect(applyPattern('{a}+{b}.pdf', 'x+y.pdf')).toEqual({ a: 'x', b: 'y' });
  });

  it('puts extra separators in the last placeholder, because matching is lazy', () => {
    expect(applyPattern('{last}_{first}_{title}.pdf', 'Smith_Jane_Senior_Recital.pdf'))
      .toEqual({ last: 'Smith', first: 'Jane', title: 'Senior_Recital' });
  });

  it('does not match a placeholder to an empty string', () => {
    expect(applyPattern('{a}_{b}.pdf', '_x.pdf')).toBeNull();
  });

  // Guards the trailing `$` anchor. Without it a filename that merely STARTS
  // like the pattern matches, silently producing partial, wrong metadata --
  // and every other "no match" test here fails for a different reason
  // (missing separator, empty capture), so none of them would notice.
  it('does not match when the filename has extra trailing characters', () => {
    expect(applyPattern('{name}.pdf', 'Report.pdfExtra')).toBeNull();
    expect(applyPattern('{last}_{first}.pdf', 'Smith_Jane.pdf.bak')).toBeNull();
  });
});
