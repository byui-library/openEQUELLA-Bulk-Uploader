import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCollections, parseSchema } from '../src/core/discovery.js';
import { extractDefinition, parseSchemaPaths } from '../src/core/schema.js';

const recorded = JSON.parse(readFileSync('tests/fixtures/api/collections.json', 'utf8'));
const recordedSchema = JSON.parse(readFileSync('tests/fixtures/api/schema.json', 'utf8'));
/** The real 200-with-no-rows an UNAUTHENTICATED request gets: available 29, results []. */
const unauthenticated = JSON.parse(
  readFileSync('tests/fixtures/api/collections-unauthenticated.json', 'utf8'),
);
/** A real AUTHENTICATED list from the test instance -- 29 entries, recorded without `full=true`. */
const testInstance = JSON.parse(
  readFileSync('tests/fixtures/api/collections-test-instance.json', 'utf8'),
);

describe('parseCollections', () => {
  it('reads the real recorded response', () => {
    const { collections } = parseCollections(recorded);
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
    expect(
      parseCollections(recorded).collections.every((c) => /^[0-9a-f-]{36}$/i.test(c.schemaUuid)),
    ).toBe(true);
  });

  it('sorts by name so the dropdown is not in server order', () => {
    const names = parseCollections({
      results: [
        { uuid: '00000000-0000-0000-0000-00000000000b', name: 'Zoology', schema: { uuid: 'x' } },
        { uuid: '00000000-0000-0000-0000-00000000000a', name: 'Archives', schema: { uuid: 'x' } },
      ],
    }).collections.map((c) => c.name);
    expect(names).toEqual(['Archives', 'Zoology']);
  });

  /**
   * An account that authenticates but can create nothing is a real state --
   * it is what a viewer-only account looks like. Returning [] lets Setup say
   * so; throwing would present it as a connection failure.
   */
  it('returns an empty list rather than throwing when there are none', () => {
    expect(parseCollections({ results: [] }).collections).toEqual([]);
    expect(parseCollections({}).collections).toEqual([]);
    expect(parseCollections(null).collections).toEqual([]);
  });

  it('skips an entry with no uuid rather than producing an unusable option', () => {
    expect(parseCollections({ results: [{ name: 'Broken', schema: { uuid: 'x' } }] }).collections)
      .toEqual([]);
  });

  it('keeps a collection that declares no schema, so it can be reported not chosen', () => {
    const [only] = parseCollections({
      results: [{ uuid: 'a'.repeat(8) + '-0000-0000-0000-000000000000', name: 'No schema' }],
    }).collections;
    expect(only?.schemaUuid).toBe('');
  });
});

/**
 * WITHHELD IS NOT EMPTY.
 *
 * openEQUELLA answers an unauthenticated request with 200 and a plausible
 * body, never 401. Measured against content-test.byui.edu with no credentials
 * at all, `GET /collection?privilege=CREATE_ITEM` returns `available: 29` with
 * ZERO results -- "there are 29; you get none" -- and the desktop rendered
 * that as "showing 0 of 0 -- No collections match", which is exactly what an
 * account with no collections looks like. Nothing anywhere said the session
 * was not signed in.
 *
 * The response DOES distinguish them, and this is the only place that
 * distinction can be made: `available > 0` with no rows can only mean the
 * server kept them back. Reported rather than thrown -- parseCollections is a
 * pure parser and its callers each have a different thing to say about it.
 */
describe('parseCollections — withheld vs genuinely empty', () => {
  it('reports the unauthenticated response as withheld, not as empty', () => {
    const list = parseCollections(unauthenticated);
    expect(list.collections).toEqual([]);
    expect(list.available).toBe(29);
    expect(list.withheld).toBe(true);
  });

  it('does not flag a real authenticated list as withheld', () => {
    const list = parseCollections(testInstance);
    expect(list.collections).toHaveLength(29);
    expect(list.available).toBe(29);
    expect(list.withheld).toBe(false);
  });

  /**
   * `available: 0` with no rows is a legitimate state -- this account can
   * create nothing -- and must keep reading as one. Flagging it as withheld
   * would send a viewer-only account off to debug their sign-in.
   */
  it('reads no collections at all as genuinely empty', () => {
    const list = parseCollections({ start: 0, length: 0, available: 0, results: [] });
    expect(list.available).toBe(0);
    expect(list.withheld).toBe(false);
  });

  /**
   * An absent `available` is not evidence of anything. Nothing is claimed
   * from a body that did not say -- the same rule as "could not check" being
   * reported as unchecked everywhere else in this tool.
   */
  it('claims nothing when the response declares no count', () => {
    expect(parseCollections({ results: [] }).withheld).toBe(false);
    expect(parseCollections(null).withheld).toBe(false);
  });

  /**
   * The count is what makes this readable, so it is carried through even
   * when every row arrived -- a caller that wants to say "29 of 29" can.
   */
  it('carries the server’s own count alongside the rows', () => {
    expect(parseCollections(recorded).available).toBe(29);
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

  /**
   * The starter profile proposes a description column, and it used to propose
   * BYU-Idaho's `MWDL/description` whatever schema it was handed. The schema
   * declares this the same way it declares the name path, so it is read the
   * same way rather than assumed.
   */
  it('reads the declared description path rather than assuming it', () => {
    expect(parseSchema(recordedSchema).descriptionPath).toBe('/MWDL/description');
    expect(parseSchema(recordedSchema).descriptionHeader).toBe('MWDL/description');
  });

  it('accepts itemDescriptionPath too, which is how the XML export spells it', () => {
    expect(
      parseSchema({ uuid: 'x', itemDescriptionPath: '/local/abstract', definition: {} })
        .descriptionHeader,
    ).toBe('local/abstract');
  });

  it('returns null rather than a guess when no description path is declared', () => {
    const schema = parseSchema({ uuid: 'x', definition: { xml: { local: { title: {} } } } });
    expect(schema.descriptionPath).toBeNull();
    expect(schema.descriptionHeader).toBeNull();
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
