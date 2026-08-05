import { describe, it, expect } from 'vitest';
import { filterCollections } from '../../../src/desktop/ui/filter.js';

const collections = [
  { uuid: '1', name: 'Sample Collection' },
  { uuid: '2', name: 'Web Utilities' },
  { uuid: '3', name: 'Education 101 Course Materials' },
  { uuid: '4', name: 'education advanced topics' },
];

describe('filterCollections', () => {
  it('matches case-insensitively', () => {
    const got = filterCollections(collections, 'EDUCATION');
    expect(got.map((c) => c.uuid).sort()).toEqual(['3', '4']);
  });

  it('matches on a substring of the name', () => {
    const got = filterCollections(collections, 'Util');
    expect(got).toEqual([{ uuid: '2', name: 'Web Utilities' }]);
  });

  it('returns everything sorted by name when the query is empty', () => {
    const got = filterCollections(collections, '');
    expect(got.map((c) => c.name)).toEqual([
      'Education 101 Course Materials',
      'education advanced topics',
      'Sample Collection',
      'Web Utilities',
    ]);
  });

  it('returns everything sorted by name when the query is only whitespace', () => {
    const got = filterCollections(collections, '   ');
    expect(got.map((c) => c.name)).toEqual([
      'Education 101 Course Materials',
      'education advanced topics',
      'Sample Collection',
      'Web Utilities',
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterCollections(collections, 'zzz-no-such-thing')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = [...collections];
    filterCollections(collections, '');
    expect(collections).toEqual(copy);
  });
});
