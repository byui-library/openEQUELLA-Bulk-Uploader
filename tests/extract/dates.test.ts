// tests/extract/dates.test.ts
import { describe, it, expect } from 'vitest';
import { dateNear, datePair } from '../../src/core/extract/dates.js';

describe('dateNear', () => {
  it('finds a date after the phrase', () => {
    expect(dateNear('He passed away on January 4, 2024, at home.', ['passed away'])).toBe(
      'January 4, 2024',
    );
  });

  it('tries each phrase in turn', () => {
    const t = 'Clyde graduated this world on January 9, 2024.';
    expect(dateNear(t, ['passed away', 'graduated this world'])).toBe('January 9, 2024');
  });

  /**
   * OCR put a space before the comma in one real file, and the first pattern
   * missed it -- which made the tool report that man's funeral date as his
   * date of death.
   */
  it('tolerates a space before the comma', () => {
    expect(dateNear('died Thursday, January 11 , 2024 at home', ['died'])).toBe('January 11 , 2024');
  });

  it('tolerates a missing comma', () => {
    expect(dateNear('died January 11 2024', ['died'])).toBe('January 11 2024');
  });

  it('ignores case in the phrase', () => {
    expect(dateNear('DIED on May 5, 1955', ['died'])).toBe('May 5, 1955');
  });

  /**
   * Without a window, "died" near the top of a document reaches a funeral date
   * hundreds of characters later. The longest real gap in the batch is
   * "returned home to his Heavenly Father on", at 39 characters.
   */
  it('does not reach a date far beyond the phrase', () => {
    const far = 'died' + ' '.repeat(120) + 'January 4, 2024';
    expect(dateNear(far, ['died'])).toBe('');
  });

  it('reaches a date within the window', () => {
    const near = 'died' + ' '.repeat(40) + 'January 4, 2024';
    expect(dateNear(near, ['died'])).toBe('January 4, 2024');
  });

  it('returns nothing when no phrase appears', () => {
    expect(dateNear('nothing relevant here', ['passed away'])).toBe('');
  });

  it('returns nothing when the phrase appears but no date follows it', () => {
    expect(dateNear('he died at home surrounded by family', ['died'])).toBe('');
  });

  it('looks only forwards, never behind the phrase', () => {
    expect(dateNear('January 4, 2024 was the year he died', ['died'])).toBe('');
  });

  /**
   * "died" often appears in a heading before it appears in the sentence that
   * carries the date. Checking only the first occurrence reports nothing while
   * the answer sits further down.
   */
  it('keeps looking past an occurrence with no date after it', () => {
    const t = 'Obituary and Death Notice. He died at home. He died on January 4, 2024.';
    expect(dateNear(t, ['died'])).toBe('January 4, 2024');
  });
});

describe('datePair', () => {
  const line = 'Eric louther Scott June 19, 1957 - January 6, 2024 St. George, Utah';

  it('takes the second date of a dash pair', () => {
    expect(datePair(line, 'second')).toBe('January 6, 2024');
  });

  it('takes the first date of a dash pair', () => {
    expect(datePair(line, 'first')).toBe('June 19, 1957');
  });

  // One real file separates them with nothing but a space.
  it('accepts a pair separated by only a space', () => {
    expect(datePair('Dennis Jack Birch January 14, 1953 January 1, 2024 Dennis', 'second')).toBe(
      'January 1, 2024',
    );
  });

  it('accepts the punctuation OCR leaves behind', () => {
    expect(datePair('Name October 20, 1943 ~ - January 3, 2024', 'second')).toBe('January 3, 2024');
  });

  /**
   * Two dates in separate sentences are not a pair. Without this, a birth date
   * and an unrelated later date would be read as a name-and-dates line.
   */
  it('is not fooled by two dates far apart', () => {
    const apart = 'Born March 4, 1950 and after a long life in Missouri he died January 2, 2024';
    expect(datePair(apart, 'second')).toBe('');
  });

  /**
   * The character class alone does not pin the gap: two dates separated by a
   * long run of punctuation and whitespace contain no letters, so only the
   * numeric bound stops them being read as a name-and-dates line. Without this
   * test, PAIR_GAP could be raised to any value and nothing would fail.
   */
  it('is not fooled by a long run of punctuation between two dates', () => {
    const padded = `March 4, 1950 ${'. '.repeat(20)} January 2, 2024`;
    expect(datePair(padded, 'second')).toBe('');
  });

  it('returns nothing when there is only one date', () => {
    expect(datePair('Born March 4, 1950 and nothing else', 'second')).toBe('');
  });

  it('returns nothing when there are no dates', () => {
    expect(datePair('no dates here at all', 'first')).toBe('');
  });

  it('takes the FIRST pair when a document holds several', () => {
    const two = 'A June 19, 1957 - January 6, 2024 then B March 4, 1950 - January 2, 2024';
    expect(datePair(two, 'second')).toBe('January 6, 2024');
  });
});
