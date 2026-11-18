import { describe, it, expect } from 'vitest';
import { buildIndex, previewLines, resolveIndexSchema } from '../../src/core/seriesIndex/build.js';
import { parseProfile } from '../../src/core/extract/profile.js';
import type { CollectionItem } from '../../src/core/client.js';

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

describe('buildIndex', () => {
  it('collects, renders and finds the existing index item', async () => {
    const asked: Array<[string, string]> = [];
    const recording = {
      ...client,
      findByField: async (_c: string, path: string, value: string) => (asked.push([path, value]), [listing[1]!]),
    };
    const b = await buildIndex({ client: recording, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile, schema });
    expect(asked).toEqual([['DC/identifier', 'FQ_index']]);
    expect(b.index.volumes).toHaveLength(1);
    expect(b.index.volumes[0]!.issues).toHaveLength(1); // the URL attachment is ignored
    expect(b.files['index.html']).toContain('<h1>Fernbrook index</h1>');
    expect(b.existing).toEqual({ kind: 'one', uuid: 'idx', version: 1, status: 'live' });
  });

  it('refuses a template with no index section', async () => {
    const { index: _drop, ...rest } = profile;
    await expect(
      buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile: rest, schema }),
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
    const b = await buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile: withGroup, schema });
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
      buildIndex({ client: c, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile: noSequence, schema }),
    ).rejects.toThrow(/no file-name patterns/);
    expect(searched).toBe(0);
  });

  it('describes the build in plain lines', async () => {
    const b = await buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile, schema });
    expect(previewLines(b)).toEqual([
      '1 volume, 1 issue.',
      'Not in the series (1): Fernbrook index -- none of its files fits the template\'s file-name patterns',
      'openEQUELLA: updates the existing index item, which stays live.',
    ]);
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
