// tests/ai/slice.test.ts
import { describe, it, expect } from 'vitest';
import { sliceForModel } from '../../src/core/ai/slice.js';
import { ValidationError } from '../../src/core/errors.js';

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

/** Sentence-shaped filler, long enough to push a section over its share. */
const FILLER = 'the group met each week and kept a careful record of what it saw. ';

/**
 * A long opening and TWO sections, each section longer than its equal share.
 *
 * The single 58-character section in `LONG_WITH_SECTION` fits under any scheme,
 * so no assertion built on it can see how the budget is divided. This one can:
 * every part wants more than an equal share, which is the only situation in
 * which the division is observable at all.
 *
 * The markers are at the START of each body, so they survive truncation, and
 * neither can be mistaken for its own heading -- `\bAbstract\b` does not match
 * inside `ABSTRACTMARK`.
 */
const TWO_SECTIONS = [
  PROSE.repeat(6),
  'Abstract',
  `ABSTRACTMARK ${FILLER.repeat(3)}`,
  'Summary',
  `SUMMARYMARK ${FILLER.repeat(3)}`,
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
   * The separators between parts are spent from the budget too.
   *
   * The single-part case above cannot see them -- one part needs no separator --
   * so an implementation that never reserved them would pass it while returning
   * 402 characters for a budget of 400. Several budgets, because whether the
   * overrun shows depends on where the word boundaries happen to fall.
   */
  it('never exceeds the budget once the separators are counted in', () => {
    const overruns = [137, 200, 301, 400, 512, 777, 900]
      .map((budget) => ({
        budget,
        length: sliceForModel(TWO_SECTIONS, { budget, sections: ['Abstract', 'Summary'] }).text
          .length,
      }))
      // Collected rather than asserted one at a time, so a failure names the
      // budget that overran instead of only the first.
      .filter(({ budget, length }) => length > budget);
    expect(overruns).toEqual([]);
  });

  /**
   * WHO IS SACRIFICED, AND WHO GETS THE SURPLUS.
   *
   * At this budget an equal three-way share is below the useful minimum, so one
   * part cannot be included and the other two share what it releases. The part
   * that goes must be the OPENING -- the tier this tool already flags as a guess
   * -- and never a section the operator named.
   *
   * Both directions of the bug are visible here: claiming order decides who is
   * dropped, and an implementation that gave a part everything it could take
   * rather than an equal share would starve both sections behind the opening.
   */
  it('sacrifices the opening before a named section when the budget is tight', () => {
    const result = sliceForModel(TWO_SECTIONS, { budget: 220, sections: ['Abstract', 'Summary'] });
    expect(result.text).toContain('ABSTRACTMARK');
    expect(result.text).toContain('SUMMARYMARK');
    expect(result.text).not.toContain('This report sets out');
    expect(result.text.length).toBeLessThanOrEqual(220);
  });

  /**
   * An equal share is a CEILING, not an allowance to be spent or lost. A part
   * that wants less than its share releases the rest, and a part that was cut
   * short takes it -- otherwise a 49-character section beside a 845-character
   * opening leaves a quarter of a local model's budget unused.
   */
  it('gives what a short part did not need to a part that was cut short', () => {
    const result = sliceForModel(LONG_WITH_SECTION, { budget: 400, sections: ['Abstract'] });
    expect(result.text).toContain('The abstract body');
    expect(result.text.length).toBeGreaterThan(380);
    expect(result.text.length).toBeLessThanOrEqual(400);
  });

  /**
   * `readOpening` returns the first prose LINE; `readSection` searches the whole
   * document. CLAUDE.md records that in the operator's real material not one of
   * twelve articles has `Abstract` at a line start -- every one follows an email
   * address or an affiliation with no punctuation between. So on a PDF, whose
   * extracted text is often one enormous line, the opening already CONTAINS the
   * abstract and charging the budget for both sends the model the same sentences
   * twice instead of twice as much document.
   */
  it('does not charge the budget twice for a section already inside the opening', () => {
    const line =
      'Some prose introduction with quite enough ordinary words in it to read as ' +
      'a paragraph. Abstract MARKERPHRASE the finding is stated plainly here. ' +
      PROSE.repeat(5);
    const result = sliceForModel(line, { budget: 400, sections: ['Abstract'] });
    expect(result.text.split('MARKERPHRASE')).toHaveLength(2);
    expect(result.text.length).toBeLessThanOrEqual(400);
  });

  /**
   * Sending half a word teaches the model that the passage was mangled, and a
   * mangled passage is where invention starts.
   *
   * Asserted against the slice's own output rather than as a verbatim prefix of
   * the document: `readOpening` is entitled to normalise what it returns, and a
   * prefix assertion would then fail here with a message about word boundaries,
   * pointing at the wrong module.
   */
  it('cuts at a word boundary rather than mid-word', () => {
    const document = PROSE.repeat(40);
    const kept = sliceForModel(document, { budget: 300, sections: [] }).text;
    const lastWord = kept.split(/\s+/).at(-1);
    expect(document.split(/\s+/)).toContain(lastWord);
  });

  /**
   * The budget arrives from an operator's text box. Left to propagate, `NaN`
   * makes every comparison false and every slice empty, so a whole batch comes
   * back as `empty` and Task 7 writes "this file has no text to read" on rows
   * whose files are full of text -- false, blaming the wrong thing, and giving
   * nobody a route back to the mistyped field.
   */
  it('refuses a budget that is not a positive number rather than reporting no text', () => {
    for (const budget of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sliceForModel(PROSE.repeat(40), { budget, sections: [] })).toThrow(
        ValidationError,
      );
    }
    expect(() => sliceForModel('x', { budget: Number.NaN, sections: [] })).toThrow(/budget/i);
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
