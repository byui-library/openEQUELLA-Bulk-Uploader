import { describe, it, expect } from 'vitest';
import { buildIndex, previewLines, resolveIndexSchema } from '../../src/core/seriesIndex/build.js';
import { parseProfile } from '../../src/core/extract/profile.js';
import type { CollectionItem } from '../../src/core/client.js';
import type { BatchRecord } from '../../src/core/seriesIndex/batchRecord.js';

const profile = parseProfile({
  version: 1,
  pattern: 'FQ_Vol{group}',
  columns: [{ path: 'attachment name', sources: [{ filename: true }] }],
  checks: { sequence: { patterns: ['{year}_Vol{group}_No{part}'], labels: { part: 'issue', group: 'volume' } } },
  index: {
    columns: [
      { path: 'DC/title', value: 'Fernbrook index' },
      { path: 'DC/description', value: 'Every volume.' },
      { path: 'DC/identifier', value: 'FQ_index' },
    ],
  },
});
const schema = {
  titleHeader: 'DC/title',
  descriptionHeader: 'DC/description',
  paths: new Set(['DC/title', 'DC/description', 'DC/identifier']),
};
const listing: CollectionItem[] = [
  {
    uuid: 'v1',
    version: 1,
    status: 'live',
    name: 'Fernbrook Vol 1',
    attachments: [
      { type: 'file', filename: 'FQ_1971_Vol1_No1.pdf', uuid: 'a1' },
      { type: 'url', filename: '', uuid: 'skip' },
    ],
  },
  { uuid: 'idx', version: 1, status: 'live', name: 'Fernbrook index', attachments: [{ type: 'file', filename: 'index.html', uuid: 'h' }] },
];
const client = {
  searchCollection: async () => listing,
  findByField: async () => [listing[1]!],
};
const collection = { kind: 'collection' } as const;

describe('buildIndex', () => {
  it('collects, renders and finds the existing index item', async () => {
    const asked: Array<[string, string]> = [];
    const recording = {
      ...client,
      findByField: async (_c: string, path: string, value: string) => (asked.push([path, value]), [listing[1]!]),
    };
    const b = await buildIndex({ client: recording, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile, schema });
    expect(asked).toEqual([['DC/identifier', 'FQ_index']]);
    expect(b.index.volumes).toHaveLength(1);
    expect(b.index.volumes[0]!.issues).toHaveLength(1); // the URL attachment is ignored
    expect(b.files['index.html']).toContain('<h1>Fernbrook index</h1>');
    expect(b.existing).toEqual({ kind: 'one', uuid: 'idx', version: 1, status: 'live' });
  });

  it('does not list the index item itself as not in the series', async () => {
    const b = await buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile, schema });
    expect(b.index.notInSeries).toEqual([]);
    expect(previewLines(b).join('\n')).not.toContain('Fernbrook index');
  });

  it('leaves out every index item when several carry the identifier', async () => {
    const twice: CollectionItem = { ...listing[1]!, uuid: 'idx2' };
    const b = await buildIndex({
      client: { searchCollection: async () => [...listing, twice], findByField: async () => [listing[1]!, twice] },
      baseUrl: 'https://oeq.example.edu',
      collectionUuid: 'c1',
      source: collection,
      profile,
      schema,
    });
    expect(b.index.notInSeries).toEqual([]);
    expect(b.existing.kind).toBe('many');
  });

  it('refuses a template with no index section', async () => {
    const { index: _drop, ...rest } = profile;
    await expect(
      buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile: rest, schema }),
    ).rejects.toThrow(/no "index" section/);
  });

  it("passes the template's groupPatterns on, so a one-file volume is placed", async () => {
    const withGroup = parseProfile({
      version: 1,
      pattern: 'FQ_Vol{group}',
      columns: [{ path: 'attachment name', sources: [{ filename: true }] }],
      checks: { sequence: { patterns: ['{year}_Vol{group}_No{part}'] } },
      index: {
        groupPatterns: ['{year}_Vol{group}'],
        columns: [
          { path: 'DC/title', value: 'Fernbrook index' },
          { path: 'DC/description', value: 'Every volume.' },
          { path: 'DC/identifier', value: 'FQ_index' },
        ],
      },
    });
    const single: CollectionItem = {
      uuid: 'v20',
      version: 1,
      status: 'live',
      name: 'Fernbrook Vol 20',
      attachments: [{ type: 'file', filename: 'FQ_1991_Vol20.pdf', uuid: 'a20' }],
    };
    const c = { searchCollection: async () => [single], findByField: async () => [] };
    const b = await buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile: withGroup, schema });
    expect(b.index.volumes).toHaveLength(1);
    expect(b.index.volumes[0]!.group).toBe(20);
    expect(b.index.notInSeries).toHaveLength(0);
  });

  it('refuses a template with no file-name patterns, before searching', async () => {
    // parseProfile itself refuses an index section without checks.sequence, so build the shape by hand.
    const noSequence = { ...profile, checks: undefined } as unknown as typeof profile;
    let searched = 0;
    const c = { ...client, searchCollection: async () => (searched++, listing) };
    await expect(
      buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile: noSequence, schema }),
    ).rejects.toThrow(/no file-name patterns/);
    expect(searched).toBe(0);
  });

  it('describes the build in plain lines', async () => {
    const b = await buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile, schema });
    expect(previewLines(b)).toEqual([
      '1 volume, 1 issue.',
      'Updates the existing index item, which stays live.',
    ]);
  });

  it("narrows by a where clause on the schema's name path, and reads everything without a prefix", async () => {
    const asked: Array<{ where?: string } | undefined> = [];
    const c = { ...client, searchCollection: async (_c: string, opts?: { where?: string }) => (asked.push(opts), listing) };
    const narrowing = { ...profile, index: { ...profile.index!, titleStartsWith: "Fernbrook's" } };
    await buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile: narrowing, schema });
    await buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile, schema });
    expect(asked[0]?.where).toBe("/xml/DC/title LIKE 'Fernbrook''s%'");
    expect(asked[1]?.where).toBeUndefined();
  });

  it('refuses a title prefix when the schema declares no name path, rather than reading everything', async () => {
    let searched = 0;
    const c = { ...client, searchCollection: async () => (searched++, listing) };
    const narrowing = { ...profile, index: { ...profile.index!, titleStartsWith: 'Fernbrook' } };
    await expect(
      buildIndex({
        client: c,
        baseUrl: 'https://oeq.example.edu',
        collectionUuid: 'c1',
        source: collection,
        profile: narrowing,
        schema: { ...schema, titleHeader: null },
      }),
    ).rejects.toThrow(/titleStartsWith.*no .*name path|name path.*titleStartsWith/s);
    expect(searched).toBe(0);
  });

  it('names the volumes the listing skips', async () => {
    const vol = (n: number): CollectionItem => ({
      uuid: `v${n}`,
      version: 1,
      status: 'live',
      name: `Fernbrook Vol ${n}`,
      attachments: [{ type: 'file', filename: `FQ_1971_Vol${n}_No1.pdf`, uuid: `a${n}` }],
    });
    const c = { searchCollection: async () => [vol(9), vol(12)], findByField: async () => [] };
    const b = await buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile, schema });
    expect(b.index.missing).toEqual([10, 11]);
    expect(previewLines(b)).toContain('No volumes found for 10, 11.');
    const one = await buildIndex({
      client: { searchCollection: async () => [vol(9), vol(11)], findByField: async () => [] },
      baseUrl: 'https://oeq.example.edu',
      collectionUuid: 'c1',
      source: collection,
      profile,
      schema,
    });
    expect(previewLines(one)).toContain('No volume found for 10.');
  });

  it('names at most 20 missing numbers, and counts the rest -- one misnamed file can open a long gap', async () => {
    const vol = (n: number): CollectionItem => ({
      uuid: `v${n}`,
      version: 1,
      status: 'live',
      name: `Fernbrook Vol ${n}`,
      attachments: [{ type: 'file', filename: `FQ_1971_Vol${n}_No1.pdf`, uuid: `a${n}` }],
    });
    const c = { searchCollection: async () => [vol(38), vol(270)], findByField: async () => [] };
    const b = await buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile, schema });
    expect(b.index.missing).toHaveLength(231);
    const first20 = Array.from({ length: 20 }, (_, i) => 39 + i).join(', ');
    expect(previewLines(b)).toContain(`No volumes found for ${first20}. ...and 211 more.`);
  });

  it('names at most 20 items not in the series, and counts the rest', async () => {
    const strays: CollectionItem[] = Array.from({ length: 23 }, (_, i) => ({
      uuid: `s${i}`,
      version: 1,
      status: 'live',
      name: `Stray ${i}`,
      attachments: [{ type: 'file', filename: `stray${i}.pdf`, uuid: `sa${i}` }],
    }));
    const c = { searchCollection: async () => strays, findByField: async () => [] };
    const b = await buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile, schema });
    const line = previewLines(b).find((l) => l.startsWith('Not in the series'))!;
    expect(line).toMatch(/^Not in the series \(23\): /);
    expect(line).toContain('Stray 19 --');
    expect(line).not.toContain('Stray 20 --');
    expect(line).toMatch(/\.\.\.and 3 more\.$/);
  });
});

describe('buildIndex from a batch record', () => {
  const record: BatchRecord = {
    kind: 'oeq-batch-record',
    version: 1,
    savedAt: '2026-11-18T19:00:00.000Z',
    baseUrl: 'https://oeq.example.edu',
    collectionUuid: 'c1',
    items: [
      { row: 2, uuid: 'v1', version: 1, title: 'Fernbrook Vol 1', label: 'FQ_1971_Vol1_No1.pdf', state: 'draft', files: [{ name: 'FQ_1971_Vol1_No1.pdf', attachmentUuid: 'a1' }] },
      { row: 3, uuid: 'idx', version: 1, title: 'Fernbrook index', label: 'index.html', state: 'draft', files: [{ name: 'index.html', attachmentUuid: 'h' }] },
    ],
    leftOut: [
      { row: 4, label: 'FQ_1972_Vol2_No1.pdf', status: 'failed', error: 'The server said no.' },
      { row: 5, label: 'Vol3 (2 files)', status: 'pending' },
    ],
  };
  const noSearch = {
    searchCollection: async (): Promise<CollectionItem[]> => {
      throw new Error('the record route must not search the collection');
    },
    findByField: async () => [listing[1]!],
  };

  it('builds from the record without searching, leaving out the index item and naming what was not created', async () => {
    const b = await buildIndex({
      client: noSearch,
      baseUrl: 'https://oeq.example.edu',
      collectionUuid: 'c1',
      source: { kind: 'record', record },
      profile,
      schema,
    });
    expect(b.index.volumes).toHaveLength(1);
    expect(b.index.volumes[0]!.issues[0]!.url).toBe('https://oeq.example.edu/items/v1/0/FQ_1971_Vol1_No1.pdf');
    expect(b.index.notInSeries).toEqual([]);
    expect(b.notCreated).toEqual(record.leftOut);
    expect(previewLines(b)).toContain(
      'Not created by the run (2): FQ_1972_Vol2_No1.pdf -- failed (The server said no.); Vol3 (2 files) -- pending',
    );
  });

  it('a collection build has nothing not created', async () => {
    const b = await buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', source: collection, profile, schema });
    expect(b.notCreated).toEqual([]);
    expect(previewLines(b).join('\n')).not.toContain('Not created');
  });
});

describe('resolveIndexSchema', () => {
  const s = { uuid: 's1', namePath: '/DC/title', titleHeader: 'DC/title', descriptionPath: null, descriptionHeader: null, paths: new Set<string>() };
  it("uses the collection's schema, else the fallback, else refuses", async () => {
    const asked: string[] = [];
    const c = (schemaUuid: string) => ({
      getCollection: async () => ({ uuid: 'c1', name: 'C', schemaUuid }),
      getSchema: async (uuid: string) => (asked.push(uuid), s),
    });
    await resolveIndexSchema(c('from-collection'), 'c1', 'fallback');
    await resolveIndexSchema(c(''), 'c1', 'fallback');
    expect(asked).toEqual(['from-collection', 'fallback']);
    await expect(resolveIndexSchema(c(''), 'c1', '')).rejects.toThrow(/schema/);
  });
});
