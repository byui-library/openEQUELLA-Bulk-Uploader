// tests/extract/labels.test.ts
import { describe, it, expect } from 'vitest';
import { findLabels } from '../../src/core/extract/labels.js';

describe('findLabels', () => {
  it('finds labelled lines', () => {
    const text = 'Senior Recital\nPerformer: Jane Smith\nInstrument: Violin\n';
    expect(findLabels(text)).toEqual(
      new Map([
        ['Performer', 'Jane Smith'],
        ['Instrument', 'Violin'],
      ]),
    );
  });

  it('keeps the first occurrence of a repeated label', () => {
    expect(findLabels('Performer: Jane\nPerformer: Someone Else\n').get('Performer')).toBe('Jane');
  });

  it('trims surrounding whitespace', () => {
    expect(findLabels('  Performer  :   Jane Smith   \n').get('Performer')).toBe('Jane Smith');
  });

  it('ignores a line whose label side is a whole sentence', () => {
    const text = 'Please note that the following applies to all students: bring your own stand.';
    expect(findLabels(text).size).toBe(0);
  });

  it('ignores a label with no value', () => {
    expect(findLabels('Performer:\n').size).toBe(0);
  });

  it('keeps colons inside the value', () => {
    expect(findLabels('Time: 7:30 PM\n').get('Time')).toBe('7:30 PM');
  });

  it('returns an empty map for empty text', () => {
    expect(findLabels('').size).toBe(0);
  });

  // The two tests below isolate the label-shape rules from each other. The
  // "whole sentence" test above is over-determined: that sentence is rejected
  // by the length cap alone, so it passes even with the word-count rule
  // deleted. Found by a mutation pass; without these, both rules could drift
  // or vanish unnoticed.

  it('ignores a short line with too many words before the colon', () => {
    // 18 characters -- well under the length cap -- but four words, so it is
    // prose, not a field name. Only the word-count rule can reject this.
    expect(findLabels('See the note below: details').size).toBe(0);
  });

  it('accepts a label at the length cap and rejects one past it', () => {
    const atCap = 'A'.repeat(40);
    const pastCap = 'A'.repeat(41);
    expect(findLabels(`${atCap}: value`).get(atCap)).toBe('value');
    expect(findLabels(`${pastCap}: value`).size).toBe(0);
  });
});
