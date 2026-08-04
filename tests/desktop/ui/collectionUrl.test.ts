import { describe, it, expect } from 'vitest';
import { collectionUrl } from '../../../src/desktop/ui/collectionUrl.js';

describe('collectionUrl', () => {
  it('builds a search-by-collection link under the given base url', () => {
    expect(collectionUrl('https://content-test.byui.edu', 'abc-123')).toBe(
      'https://content-test.byui.edu/page/search?collections=abc-123',
    );
  });

  it('URL-encodes a uuid containing characters that need escaping', () => {
    expect(collectionUrl('https://content-test.byui.edu', 'a b&c')).toBe(
      'https://content-test.byui.edu/page/search?collections=a%20b%26c',
    );
  });
});
