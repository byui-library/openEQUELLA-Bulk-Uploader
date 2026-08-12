import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCollections } from '../src/core/discovery.js';

const recorded = JSON.parse(readFileSync('tests/fixtures/api/collections.json', 'utf8'));

describe('parseCollections', () => {
  it('reads the real recorded response', () => {
    const collections = parseCollections(recorded);
    expect(collections.length).toBeGreaterThan(0);
    for (const c of collections) {
      expect(c.uuid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  /**
   * A list entry carries its own schema uuid, so Setup can go collection ->
   * schema without a second request per collection. Losing it here would
   * reintroduce that request for no reason.
   */
  it('carries the schema uuid through', () => {
    expect(parseCollections(recorded).every((c) => /^[0-9a-f-]{36}$/i.test(c.schemaUuid))).toBe(
      true,
    );
  });

  it('sorts by name so the dropdown is not in server order', () => {
    const names = parseCollections({
      results: [
        { uuid: '00000000-0000-0000-0000-00000000000b', name: 'Zoology', schema: { uuid: 'x' } },
        { uuid: '00000000-0000-0000-0000-00000000000a', name: 'Archives', schema: { uuid: 'x' } },
      ],
    }).map((c) => c.name);
    expect(names).toEqual(['Archives', 'Zoology']);
  });

  /**
   * An account that authenticates but can create nothing is a real state --
   * it is what a viewer-only account looks like. Returning [] lets Setup say
   * so; throwing would present it as a connection failure.
   */
  it('returns an empty list rather than throwing when there are none', () => {
    expect(parseCollections({ results: [] })).toEqual([]);
    expect(parseCollections({})).toEqual([]);
    expect(parseCollections(null)).toEqual([]);
  });

  it('skips an entry with no uuid rather than producing an unusable option', () => {
    expect(parseCollections({ results: [{ name: 'Broken', schema: { uuid: 'x' } }] })).toEqual([]);
  });

  it('keeps a collection that declares no schema, so it can be reported not chosen', () => {
    const [only] = parseCollections({
      results: [{ uuid: 'a'.repeat(8) + '-0000-0000-0000-000000000000', name: 'No schema' }],
    });
    expect(only?.schemaUuid).toBe('');
  });
});
