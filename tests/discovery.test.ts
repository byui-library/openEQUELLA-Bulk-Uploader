import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCollections, parseSchema } from '../src/core/discovery.js';
import { extractDefinition, parseSchemaPaths } from '../src/core/schema.js';

const recorded = JSON.parse(readFileSync('tests/fixtures/api/collections.json', 'utf8'));
const recordedSchema = JSON.parse(readFileSync('tests/fixtures/api/schema.json', 'utf8'));

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

describe('parseSchema', () => {
  /**
   * THE test for this module. `schema/_entity.xml` and the recorded API
   * response describe the SAME schema by two routes, so any disagreement is a
   * bug in one of them. Worth more than any hand-written fixture, and it is
   * what caught all three walker bugs.
   */
  it('agrees exactly with the XML export of the same schema', () => {
    const fromXml = parseSchemaPaths(extractDefinition(readFileSync('schema/_entity.xml', 'utf8')));
    const fromApi = parseSchema(recordedSchema).paths;
    expect([...fromXml].filter((p) => !fromApi.has(p))).toEqual([]);
    expect([...fromApi].filter((p) => !fromXml.has(p))).toEqual([]);
  });

  it('reads the declared title path rather than assuming it', () => {
    expect(parseSchema(recordedSchema).namePath).toBe('/MWDL/title');
  });

  it('strips the leading slash so it matches spreadsheet header form', () => {
    expect(parseSchema(recordedSchema).titleHeader).toBe('MWDL/title');
  });

  it('accepts itemNamePath too, which is how the XML export spells it', () => {
    expect(parseSchema({ uuid: 'x', itemNamePath: '/local/title', definition: {} }).titleHeader).toBe(
      'local/title',
    );
  });

  /**
   * A schema with no declared name path must NOT silently become "clean" in
   * duplicate detection. null here is what Task 8 turns into "could not check".
   */
  it('returns null rather than a guess when no name path is declared', () => {
    const schema = parseSchema({ uuid: 'x', definition: { xml: { local: { title: {} } } } });
    expect(schema.namePath).toBeNull();
    expect(schema.titleHeader).toBeNull();
  });

  it('emits leaves only, never containers', () => {
    const { paths } = parseSchema({
      uuid: 'x',
      definition: { xml: { local: { creators: { creator: {} }, title: {} } } },
    });
    expect(paths.has('local/creators/creator')).toBe(true);
    expect(paths.has('local/creators')).toBe(false);
    expect(paths.has('local/title')).toBe(true);
  });

  it('treats @attributes as addressable and _metadata as not', () => {
    const { paths } = parseSchema({
      uuid: 'x',
      definition: { xml: { local: { oai: { '@id': { _type: 'text' } }, plain: { _type: 'text' } } } },
    });
    expect(paths.has('local/oai/id')).toBe(true);
    expect(paths.has('local/plain')).toBe(true);
    expect([...paths].some((p) => p.includes('_type'))).toBe(false);
  });

  it('survives a schema with no definition at all', () => {
    expect(parseSchema({ uuid: 'x' }).paths.size).toBe(0);
  });
});
