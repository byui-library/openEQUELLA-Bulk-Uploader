import { describe, it, expect } from 'vitest';
import { DESCRIPTION_LIMIT, limitFor, shortenText } from '../../src/core/extract/length.js';

describe('shortenText', () => {
  it('leaves text within the limit and two paragraphs untouched', () => {
    expect(shortenText('One. Two.\n\nThree.', 100)).toEqual({ text: 'One. Two.\n\nThree.', shortened: false });
  });

  it('ends at the last whole sentence that fits', () => {
    const text = 'The first sentence is quite long enough to keep entirely on its own here. And a second runs over.';
    expect(shortenText(text, 90)).toEqual({
      text: 'The first sentence is quite long enough to keep entirely on its own here.',
      shortened: true,
    });
  });

  it('counts a sentence closed inside quotation marks', () => {
    const text = 'He called the valley "the finest farmland anywhere in the whole west." Then more words follow.';
    expect(shortenText(text, 80).text).toBe('He called the valley "the finest farmland anywhere in the whole west."');
  });

  it('falls back to a whole word when no sentence ends late enough', () => {
    const text = `${'word '.repeat(40)}end.`;
    const { text: out } = shortenText(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('word')).toBe(true);
  });

  it('cuts a text with no spaces at the limit rather than to nothing', () => {
    expect(shortenText('x'.repeat(500), 100).text).toHaveLength(100);
  });

  it('keeps two paragraphs at most', () => {
    expect(shortenText('A.\n\nB.\n\nC.', 100)).toEqual({ text: 'A.\n\nB.', shortened: true });
  });
});

describe('limitFor', () => {
  it("is the column's own limit, or 1,000", () => {
    expect(DESCRIPTION_LIMIT).toBe(1000);
    expect(limitFor({})).toBe(1000);
    expect(limitFor({ maxLength: 300 })).toBe(300);
  });
});
