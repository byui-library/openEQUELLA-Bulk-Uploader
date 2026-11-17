import { describe, it, expect } from 'vitest';
import { DESCRIPTION_LIMIT, limitFor, shortenText } from '../../src/core/extract/length.js';

describe('shortenText', () => {
  it('leaves text within the limit untouched, paragraphs and all', () => {
    expect(shortenText('One.\n\nTwo.\n\nThree.', 100)).toEqual({ text: 'One.\n\nTwo.\n\nThree.', cutAt: null });
  });

  it('ends at the last whole sentence that fits', () => {
    const text = 'The first sentence is quite long enough to keep entirely on its own here. And a second runs over.';
    expect(shortenText(text, 90)).toEqual({
      text: 'The first sentence is quite long enough to keep entirely on its own here.',
      cutAt: 'sentence',
    });
  });

  // The text AFTER the cut decides. "2." at the limit, inside "2.5", is a
  // number, and the old opening.ts rule (". ") never took it for a sentence.
  it('does not take a full stop that lands on the limit, inside a number, for a sentence end', () => {
    const lead = 'An opening sentence that is comfortably longer than sixty characters. ';
    const text = `${lead}The grant came to 2.5 million dollars.`;
    const limit = text.indexOf('2.') + 2;
    expect(shortenText(text, limit)).toEqual({ text: lead.trim(), cutAt: 'sentence' });
  });

  it('counts a sentence closed inside quotation marks', () => {
    const text = 'He called the valley "the finest farmland anywhere in the whole west." Then more words follow.';
    expect(shortenText(text, 80).text).toBe('He called the valley "the finest farmland anywhere in the whole west."');
  });

  it('falls back to a whole word when no sentence ends late enough', () => {
    const text = `${'word '.repeat(40)}end.`;
    const { text: out, cutAt } = shortenText(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('word')).toBe(true);
    expect(cutAt).toBe('word');
  });

  it('cuts a text with no spaces at the limit rather than to nothing', () => {
    expect(shortenText('x'.repeat(500), 100)).toEqual({ text: 'x'.repeat(100), cutAt: 'limit' });
  });
});

describe('limitFor', () => {
  it("is the column's own limit, or 1,000", () => {
    expect(DESCRIPTION_LIMIT).toBe(1000);
    expect(limitFor({})).toBe(1000);
    expect(limitFor({ maxLength: 300 })).toBe(300);
  });
});
