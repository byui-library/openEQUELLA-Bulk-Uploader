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
});
