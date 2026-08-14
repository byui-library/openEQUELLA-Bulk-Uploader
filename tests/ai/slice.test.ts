// tests/ai/slice.test.ts
import { describe, it, expect } from 'vitest';
import { sliceForModel } from '../../src/core/ai/slice.js';

/**
 * A real prose paragraph.
 *
 * `readOpening` will not call anything an opening unless it has ten words of
 * two letters or more, a sentence ending, and is mostly lowercase. A run of
 * `x`s is none of those, so a fixture built from one gets an EMPTY opening and
 * exercises nothing in this module -- a trap the first draft of these tests
 * fell into, and the reason this constant exists.
 */
const PROSE =
  'This report sets out what the working group found over three years of ' +
  'observation at a small college, and what it recommends to the library. ';

/** Long prose, one Abstract section, and a Keywords heading to end it. */
const LONG_WITH_SECTION = [
  PROSE.repeat(6),
  'Abstract',
  'The abstract body states the finding in one line.',
  'Keywords',
  'reading, undergraduates, libraries',
].join('\n');

describe('sliceForModel', () => {
  it('sends a short document whole', () => {
    const result = sliceForModel('A short obituary.', { budget: 1000, sections: [] });
    expect(result.text).toBe('A short obituary.');
    expect(result.shape).toBe('whole');
  });

  /** The death date can be in the last line. Truncation would lose it. */
  it('keeps the end of a document that fits', () => {
    const text = 'x'.repeat(500) + ' He died on 6 January 2019.';
    expect(sliceForModel(text, { budget: 1000, sections: [] }).text).toContain('6 January 2019');
  });

  /**
   * THE PART THAT IS NOT OBVIOUS. A named section is the higher-signal half --
   * the operator named it precisely because that is where the answer lives --
   * and an opening long enough to overflow the budget is exactly when the
   * section matters most. Joining the parts and taking the leading N characters
   * hands the whole budget to the opening and the section never arrives.
   */
  it('falls back to the opening plus named sections when it does not fit', () => {
    const result = sliceForModel(LONG_WITH_SECTION, { budget: 200, sections: ['Abstract'] });
    expect(result.shape).toBe('opening+sections');
    expect(result.text).toContain('This report sets out');
    expect(result.text).toContain('The abstract body');
    expect(result.text.length).toBeLessThanOrEqual(200);
  });

  it('never exceeds the budget', () => {
    const result = sliceForModel(PROSE.repeat(40), { budget: 300, sections: [] });
    expect(result.text.length).toBeLessThanOrEqual(300);
    // Not vacuously: a slice that came back empty would satisfy the line above
    // while proving nothing about the budget.
    expect(result.text.length).toBeGreaterThan(100);
  });

  /**
   * Sending half a word teaches the model that the passage was mangled, and a
   * mangled passage is where invention starts.
   */
  it('cuts at a word boundary rather than mid-word', () => {
    const document = PROSE.repeat(40);
    const kept = sliceForModel(document, { budget: 300, sections: [] }).text;
    expect(document.startsWith(kept)).toBe(true);
    expect(document[kept.length]).toBe(' ');
  });

  it('reports an empty document rather than pretending it sent something', () => {
    expect(sliceForModel('', { budget: 100, sections: [] })).toEqual({ text: '', shape: 'empty' });
  });

  /**
   * A long document with no prose and no headings yields nothing to send.
   * Calling that 'opening+sections' with an empty string would be this
   * codebase's oldest bug -- a step that could not run, reported as if it had
   * -- and would send a model a prompt with no document under it, which can
   * only produce invention.
   */
  it('reports nothing to send as empty rather than as an opening it never found', () => {
    expect(sliceForModel('z'.repeat(10_000), { budget: 300, sections: [] })).toEqual({
      text: '',
      shape: 'empty',
    });
  });

  /**
   * A budget small enough that no part survives whole is the same case arrived
   * at from the other direction, and an operator who typed 20 into the budget
   * box will reach it.
   */
  it('reports a budget too small for any part as empty, not as an empty slice', () => {
    expect(sliceForModel(LONG_WITH_SECTION, { budget: 20, sections: ['Abstract'] })).toEqual({
      text: '',
      shape: 'empty',
    });
  });
});
