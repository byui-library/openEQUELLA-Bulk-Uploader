import { describe, it, expect } from 'vitest';
import { missingNote } from '../../src/core/seriesIndex/words.js';

const L = { group: 'volume', groups: 'volumes' };

describe('missingNote', () => {
  it('names the gaps and counts the rest', () => {
    expect(missingNote({ missing: [10], missingCount: 1 }, L)).toBe('No volume found for 10.');
    expect(missingNote({ missing: [10, 11], missingCount: 25 }, L)).toBe('No volumes found for 10, 11. ...and 5 more.');
  });

  it('says nothing rather than print a list with no numbers in it', () => {
    expect(missingNote({ missing: [], missingCount: 0 }, L)).toBe('');
    expect(missingNote({ missing: [], missingCount: 3 }, L)).toBe('');
  });
});
