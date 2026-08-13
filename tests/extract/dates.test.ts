// tests/extract/dates.test.ts
import { describe, it, expect } from 'vitest';
import { dateNear, datePair, datesNear } from '../../src/core/extract/dates.js';

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

  /**
   * "died" is a substring of "studied", and this is an alumni collection where
   * "studied at Ricks College" is near-certain. A raw substring search read a
   * man's marriage date as his date of death.
   */
  it('does not match a phrase inside a longer word', () => {
    expect(
      dateNear('He studied at Ricks College and married Mary on June 12, 1955.', ['died']),
    ).toBe('');
  });

  it('does not match a phrase at the end of a longer word', () => {
    expect(dateNear('a full-bodied life began on March 3, 1940', ['died'])).toBe('');
  });

  it('still matches a phrase against surrounding punctuation', () => {
    expect(dateNear('(died) January 4, 2024', ['died'])).toBe('January 4, 2024');
  });

  /**
   * `\d{4}` with nothing after it read a year out of a longer run of digits,
   * and 1234 normalises cleanly, so it would never have been flagged. This
   * batch's OCR mangles digit runs -- `01104/2024`, `04[031.193:5`.
   */
  it('does not read a year out of a longer run of digits', () => {
    expect(dateNear('died January 11 12345', ['died'])).toBe('');
  });

  it('does not match a month inside a longer word', () => {
    expect(dateNear('died in Mayfield 3, 1940', ['died'])).toBe('');
  });
});

describe('datesNear', () => {
  it('reports one date once', () => {
    expect(datesNear('He died January 4, 2024.', ['died'])).toEqual(['January 4, 2024']);
  });

  /**
   * Almost every obituary names someone else's death. Nothing can reliably
   * tell whose death a sentence describes, so both are reported and the row
   * gets flagged rather than confidently carrying the wrong one.
   */
  it('reports both when a relative death is also stated', () => {
    const t =
      'He was preceded in death by his wife Ruth, who passed away on March 2, 1998. He died January 4, 2024.';
    expect(datesNear(t, ['passed away', 'died'])).toEqual(['March 2, 1998', 'January 4, 2024']);
  });

  it('does not report the same date twice when two phrases reach it', () => {
    expect(datesNear('he died and passed away on January 4, 2024', ['died', 'passed away'])).toEqual(
      ['January 4, 2024'],
    );
  });

  it('reports nothing when no phrase matches', () => {
    expect(datesNear('nothing here', ['died'])).toEqual([]);
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

  /**
   * A birth date at the end of a sentence must not pair with a funeral date in
   * the next paragraph. The gap excludes letters and digits, which is not
   * enough on its own -- a full stop and two newlines are only three
   * characters.
   */
  it('does not pair across a sentence end and a paragraph break', () => {
    expect(
      datePair('He was born on June 19, 1957.\n\nJanuary 6, 2024 funeral services', 'second'),
    ).toBe('');
  });

  /**
   * The gap's docstring has always said no SENTENCE TERMINATOR may appear
   * between the two halves, but the class excluded only the full stop, so a
   * sentence ending in '!' or '?' reopened exactly the hole the paragraph-break
   * case above closes -- a birth date paired with an unrelated later one.
   */
  it('does not pair across an exclamation mark', () => {
    expect(datePair('What a life he led from June 19, 1957! January 6, 2024', 'second')).toBe('');
  });

  it('does not pair across a question mark', () => {
    expect(datePair('Was he born June 19, 1957? January 6, 2024 was the funeral', 'second')).toBe(
      '',
    );
  });

  // Pins PAIR_GAP itself: 14 characters of punctuation, just over the bound.
  it('does not pair across a gap slightly larger than the limit', () => {
    expect(datePair(`March 4, 1950${' -'.repeat(7)}January 2, 2024`, 'second')).toBe('');
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
