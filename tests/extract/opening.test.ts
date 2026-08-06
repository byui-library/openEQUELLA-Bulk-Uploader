// tests/extract/opening.test.ts
import { describe, it, expect } from 'vitest';
import { readOpening } from '../../src/core/extract/opening.js';

/**
 * The last resort before an empty cell. Unlike a table cell or a named section,
 * this one is a guess: the first substantial run of prose in the document, on
 * the theory that documents tend to start by saying what they are. Everything
 * it produces is flagged, because on a published PDF the opening is as likely
 * to be a masthead as a summary.
 */

describe('readOpening', () => {
  it('takes the first substantial paragraph', () => {
    const text = [
      'ELIJAH AND ELISHA',
      'THE STORY SO FAR',
      'After Solomon died, ten tribes broke away and the kingdom split. Kings came ' +
        'and went, mostly wicked ones, but God never left His people without prophets. ' +
        'He sent Elijah and Elisha to the north, and Isaiah to the south.',
    ].join('\n');
    expect(readOpening(text)).toMatch(/^After Solomon died/);
  });

  // A heading, a title and a date line are all short. Prose is not.
  it('skips headings and fragments that are too short to be prose', () => {
    const text = ['UNITED', 'Saul, David,', '931 BC', 'Kingdom splits'].join('\n');
    expect(readOpening(text)).toBe('');
  });

  // Each of the three below is written to fail exactly ONE rule and satisfy the
  // others, so that removing that rule breaks this test and nothing else does
  // its work for it. The first drafts all failed on the sentence rule by
  // accident, and passed unchanged when the rule they named was deleted.
  it('skips a short line even when it is a real sentence', () => {
    expect(readOpening('It is a bit of a run of very small words here.')).toBe('');
  });

  it('skips a run of capitals even when it is long and punctuated', () => {
    const shouting =
      'MEDICAL BENEFITS SUMMARY PLAN DESCRIPTION FOR ALL ELIGIBLE FULL TIME EMPLOYEES.';
    expect(readOpening(shouting)).toBe('');
  });

  // A filename passes every other rule: long enough, lowercase, has a dot.
  it('skips a long line that is not made of words', () => {
    expect(readOpening('elijah_and_elisha_lesson_plan_2026_final_approved_version.docx')).toBe('');
  });

  it('skips a long lowercase run with no sentence in it', () => {
    const listing = 'this is a list of ordinary lowercase words with no ending punctuation anywhere';
    expect(readOpening(listing)).toBe('');
  });

  // What actually opens a published article. Every one of these was in the
  // first 400 characters of the operator's own PDFs.
  it.each([
    '© 2025 The Authors. Published by Elsevier under a CC BY licence agreement here.',
    'Copyright: This is an open access article distributed under the Creative Commons licence.',
    'doi: 10.1371/journal.pone.0332500 October 8, 2025 and the rest of the citation line',
    'https://doi.org/10.3390/app15094829 with more of the same url boilerplate following on',
    'Received: 24 August 2025 Accepted: 12 September 2025 Published: 1 October 2025 online',
    'Citation: Ibanez, S.J.; Gomez, M.A. Differences in External Load. Applied Sciences 2025.',
    'Academic Editor: C. Peham, University of Veterinary Medicine, Vienna, Austria, Europe',
    'ISSN 2076-3417 and other identifiers that say nothing about what this document is',
  ])('skips publication boilerplate: %s', (line) => {
    const real = 'The aim of this study was to describe the demands of professional basketball games.';
    expect(readOpening(`${line}\n${real}`)).toBe(real);
  });

  it('returns nothing rather than a guess when there is no prose at all', () => {
    expect(readOpening('')).toBe('');
    expect(readOpening('1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22')).toBe('');
  });

  /**
   * A PDF's extracted text often has no line breaks at all, so the whole
   * document arrives as one block. Without a cap that block IS the value, and a
   * 68,000-character article would land in a description cell.
   */
  it('cuts a long run of prose at a sentence end', () => {
    const sentence = 'This sentence is a perfectly ordinary length for running prose. ';
    const result = readOpening(sentence.repeat(40));
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result.endsWith('.')).toBe(true);
  });

  it('keeps a paragraph that is already short enough, whole', () => {
    const one = 'The aim of this study was to describe the specific demands of the sport in detail.';
    expect(readOpening(one)).toBe(one);
  });
});
