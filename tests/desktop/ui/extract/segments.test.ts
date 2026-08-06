// tests/desktop/ui/extract/segments.test.ts
import { describe, it, expect } from 'vitest';
import { describeFilename } from '../../../../src/desktop/ui/extract/segments.js';

describe('describeFilename', () => {
  it('pairs each placeholder with what it captured', () => {
    expect(describeFilename('{last}_{first}.pdf', 'Smith_Jane.pdf')).toEqual({
      matched: true,
      parts: [
        { name: 'last', value: 'Smith' },
        { name: 'first', value: 'Jane' },
      ],
    });
  });

  it('reports no match without throwing, and still lists the placeholder names', () => {
    expect(describeFilename('{last}_{first}.pdf', 'nomatch.pdf')).toEqual({
      matched: false,
      parts: [
        { name: 'last', value: '' },
        { name: 'first', value: '' },
      ],
    });
  });

  it('reports no match for a pattern that is not valid', () => {
    expect(describeFilename('{a}_{a}.pdf', 'x_y.pdf')).toEqual({ matched: false, parts: [] });
  });

  it('handles a pattern with no placeholders', () => {
    expect(describeFilename('report.pdf', 'report.pdf')).toEqual({ matched: true, parts: [] });
  });
});
