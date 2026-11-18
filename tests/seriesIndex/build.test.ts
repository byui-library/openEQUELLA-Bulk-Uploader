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
    const b = await buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile, schema });
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
