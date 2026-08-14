// tests/extract/dates.test.ts
import { describe, it, expect } from 'vitest';
import { dateNear, datePair, datesNear } from '../../src/core/extract/dates.js';

describe('dateNear', () => {
  it('finds a date after the phrase', () => {
    expect(dateNear('He passed away on September 8, 2019, at home.', ['passed away'])).toBe(
      'September 8, 2019',
    );
  });

  it('tries each phrase in turn', () => {
    const t = 'Marcus graduated this world on March 5, 2019.';
    expect(dateNear(t, ['passed away', 'graduated this world'])).toBe('March 5, 2019');
  });

  /**
   * OCR put a space before the comma in one real file, and the first pattern
   * missed it -- which made the tool report that man's funeral date as his
   * date of death.
   */
  it('tolerates a space before the comma', () => {
    expect(dateNear('died Thursday, February 11 , 2019 at home', ['died'])).toBe(
      'February 11 , 2019',
    );
  });

  it('tolerates a missing comma', () => {
    expect(dateNear('died February 11 2019', ['died'])).toBe('February 11 2019');
  });

  it('ignores case in the phrase', () => {
    expect(dateNear('DIED on August 5, 1952', ['died'])).toBe('August 5, 1952');
  });

  /**
   * Without a window, "died" near the top of a document reaches a funeral date
   * hundreds of characters later. The longest real gap in the batch is
   * "returned home to his Heavenly Father on", at 39 characters.
   */
  it('does not reach a date far beyond the phrase', () => {
    const far = 'died' + ' '.repeat(120) + 'September 8, 2019';
    expect(dateNear(far, ['died'])).toBe('');
  });

  it('reaches a date within the window', () => {
    const near = 'died' + ' '.repeat(40) + 'September 8, 2019';
    expect(dateNear(near, ['died'])).toBe('September 8, 2019');
  });

  it('returns nothing when no phrase appears', () => {
    expect(dateNear('nothing relevant here', ['passed away'])).toBe('');
  });

  it('returns nothing when the phrase appears but no date follows it', () => {
    expect(dateNear('he died at home surrounded by family', ['died'])).toBe('');
  });

  it('looks only forwards, never behind the phrase', () => {
    expect(dateNear('September 8, 2019 was the year he died', ['died'])).toBe('');
  });

  /**
   * "died" often appears in a heading before it appears in the sentence that
   * carries the date. Checking only the first occurrence reports nothing while
   * the answer sits further down.
   */
  it('keeps looking past an occurrence with no date after it', () => {
    const t = 'Obituary and Death Notice. He died at home. He died on September 8, 2019.';
    expect(dateNear(t, ['died'])).toBe('September 8, 2019');
  });

  /**
   * "died" is a substring of "studied", and this is an alumni collection where
   * "studied at Ricks College" is near-certain. A raw substring search read a
   * man's marriage date as his date of death.
   */
  it('does not match a phrase inside a longer word', () => {
    expect(
      dateNear('He studied at Ricks College and married Thea on April 2, 1953.', ['died']),
    ).toBe('');
  });

  it('does not match a phrase at the end of a longer word', () => {
    expect(dateNear('a full-bodied life began on September 21, 1943', ['died'])).toBe('');
  });

  it('still matches a phrase against surrounding punctuation', () => {
    expect(dateNear('(died) September 8, 2019', ['died'])).toBe('September 8, 2019');
  });

  /**
   * `\d{4}` with nothing after it read a year out of a longer run of digits,
   * and 1234 normalises cleanly, so it would never have been flagged. This
   * batch's OCR routinely mangles a numeric date into a longer digit run.
   */
  it('does not read a year out of a longer run of digits', () => {
    expect(dateNear('died February 11 12345', ['died'])).toBe('');
  });

  it('does not match a month inside a longer word', () => {
    expect(dateNear('died in Mayfield 3, 1940', ['died'])).toBe('');
  });
});

describe('datesNear', () => {
  it('reports one date once', () => {
    expect(datesNear('He died September 8, 2019.', ['died'])).toEqual(['September 8, 2019']);
  });

  /**
   * Almost every obituary names someone else's death. Nothing can reliably
   * tell whose death a sentence describes, so both are reported and the row
   * gets flagged rather than confidently carrying the wrong one.
   */
  it('reports both when a relative death is also stated', () => {
    const t =
      'He was preceded in death by his wife Ivy, who passed away on November 8, 1994. He died September 8, 2019.';
    expect(datesNear(t, ['passed away', 'died'])).toEqual(['November 8, 1994', 'September 8, 2019']);
  });

  it('does not report the same date twice when two phrases reach it', () => {
    expect(datesNear('he died and passed away on September 8, 2019', ['died', 'passed away'])).toEqual(
      ['September 8, 2019'],
    );
  });

  it('reports nothing when no phrase matches', () => {
    expect(datesNear('nothing here', ['died'])).toEqual([]);
  });
});

describe('datePair', () => {
  const line = 'Gideon olwyn Alder April 5, 1954 - October 2, 2019 Wheatfield, Utah';

  it('takes the second date of a dash pair', () => {
    expect(datePair(line, 'second')).toBe('October 2, 2019');
  });

  it('takes the first date of a dash pair', () => {
    expect(datePair(line, 'first')).toBe('April 5, 1954');
  });

  // One real file separates them with nothing but a space.
  it('accepts a pair separated by only a space', () => {
    expect(datePair('Corwin Ames Teasel August 14, 1951 May 1, 2019 Corwin', 'second')).toBe(
      'May 1, 2019',
    );
  });

  it('accepts the punctuation OCR leaves behind', () => {
    expect(datePair('Name December 8, 1947 ~ - July 3, 2019', 'second')).toBe('July 3, 2019');
  });

  /**
   * Two dates in separate sentences are not a pair. Without this, a birth date
   * and an unrelated later date would be read as a name-and-dates line.
   */
  it('is not fooled by two dates far apart', () => {
    const apart = 'Born October 12, 1946 and after a long life in Missouri he died April 9, 2018';
    expect(datePair(apart, 'second')).toBe('');
  });

  /**
   * The character class alone does not pin the gap: two dates separated by a
   * long run of punctuation and whitespace contain no letters, so only the
   * numeric bound stops them being read as a name-and-dates line. Without this
   * test, PAIR_GAP could be raised to any value and nothing would fail.
   */
  it('is not fooled by a long run of punctuation between two dates', () => {
    const padded = `October 12, 1946 ${'. '.repeat(20)} April 9, 2018`;
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
      datePair('He was born on April 5, 1954.\n\nOctober 2, 2019 funeral services', 'second'),
    ).toBe('');
  });

  /**
   * The gap's docstring has always said no SENTENCE TERMINATOR may appear
   * between the two halves, but the class excluded only the full stop, so a
   * sentence ending in '!' or '?' reopened exactly the hole the paragraph-break
   * case above closes -- a birth date paired with an unrelated later one.
   */
  it('does not pair across an exclamation mark', () => {
    expect(datePair('What a life he led from April 5, 1954! October 2, 2019', 'second')).toBe('');
  });

  it('does not pair across a question mark', () => {
    expect(datePair('Was he born April 5, 1954? October 2, 2019 was the funeral', 'second')).toBe(
      '',
    );
  });

  // Pins PAIR_GAP itself: 14 characters of punctuation, just over the bound.
  it('does not pair across a gap slightly larger than the limit', () => {
    expect(datePair(`October 12, 1946${' -'.repeat(7)}April 9, 2018`, 'second')).toBe('');
  });

  it('returns nothing when there is only one date', () => {
    expect(datePair('Born October 12, 1946 and nothing else', 'second')).toBe('');
  });

  it('returns nothing when there are no dates', () => {
    expect(datePair('no dates here at all', 'first')).toBe('');
  });

  it('takes the FIRST pair when a document holds several', () => {
    const two = 'A April 5, 1954 - October 2, 2019 then B October 12, 1946 - April 9, 2018';
    expect(datePair(two, 'second')).toBe('October 2, 2019');
  });
});
