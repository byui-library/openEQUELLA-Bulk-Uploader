import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIndexFlags, indexAction } from '../src/cli/indexPage.js';
import type { BatchRecord } from '../src/core/seriesIndex/batchRecord.js';
import { resolveIndexSource } from '../src/core/seriesIndex/build.js';
import { writeJsonAtomic } from '../src/core/state.js';
import { ValidationError } from '../src/core/errors.js';

describe('oeq-upload index flags', () => {
  it('previews when given no destination', () => {
    expect(checkIndexFlags({ template: 't.json' })).toEqual({ out: null, upload: null, link: false, records: null });
  });
  it('requires exactly one of --draft and --publish with --upload', () => {
    expect(() => checkIndexFlags({ template: 't', upload: true })).toThrow(/--draft or --publish/);
    expect(() => checkIndexFlags({ template: 't', upload: true, draft: true, publish: true })).toThrow(/--draft or --publish/);
    expect(checkIndexFlags({ template: 't', upload: true, publish: true }).upload).toEqual({ draft: false });
  });
  it('refuses --force without --out, and --draft/--publish without --upload', () => {
    expect(() => checkIndexFlags({ template: 't', force: true })).toThrow(/--force/);
    expect(() => checkIndexFlags({ template: 't', draft: true })).toThrow(/--upload/);
  });
  it('refuses --link-volumes without --upload, which guarantees the index item exists', () => {
    expect(() => checkIndexFlags({ template: 't', linkVolumes: true })).toThrow(/--link-volumes needs --upload/);
    expect(() => checkIndexFlags({ template: 't', linkVolumes: true, out: 'dir' })).toThrow(/--link-volumes needs --upload/);
    expect(checkIndexFlags({ template: 't', linkVolumes: true, upload: true, draft: true }).link).toBe(true);
  });
  it('carries --from-record through, and is null without it', () => {
    expect(() => checkIndexFlags({ template: 't', fromRecord: [] })).toThrow(/at least one/);
    expect(checkIndexFlags({ template: 't' }).records).toBeNull();
    expect(checkIndexFlags({ template: 't', fromRecord: ['a.index.json', 'b.index.json'] }).records).toEqual([
      'a.index.json',
      'b.index.json',
    ]);
  });
});

describe('oeq-upload index --from-record', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oeq-cli-index-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record = (over: Partial<BatchRecord> = {}): BatchRecord => ({
    kind: 'oeq-batch-record',
    version: 1,
    savedAt: '2026-11-18T19:00:00.000Z',
    baseUrl: 'https://oeq.example.edu',
    collectionUuid: 'coll-from-record',
    items: [
      {
        row: 2,
        uuid: 'item-1',
        version: 1,
        title: 'Fernbrook Quarterly Vol 1',
        label: 'FQ_1970_Vol1_No1.pdf',
        state: 'draft',
        files: [{ name: 'FQ_1970_Vol1_No1.pdf', attachmentUuid: 'att-1' }],
      },
    ],
    leftOut: [],
    ...over,
  });

  const save = async (r: BatchRecord): Promise<string> => {
    const path = join(dir, 'job.index.json');
    await writeJsonAtomic(path, r);
    return path;
  };

  // As the CLI calls it: the configured collection is both the default and the one OEQ_SCHEMA_UUID describes.
  const site = (baseUrl: string, collectionUuid: string) => ({
    baseUrl,
    collectionUuid,
    configuredCollectionUuid: collectionUuid,
    configuredSchemaUuid: 'schema-configured',
  });

  it('builds from the record, in its collection, whatever OEQ_COLLECTION_UUID says', async () => {
    const path = await save(record());
    const got = await resolveIndexSource([path], site('https://oeq.example.edu/', 'coll-configured'));
    expect(got.collectionUuid).toBe('coll-from-record');
    expect(got.source.kind).toBe('record');
    if (got.source.kind === 'record') expect(got.source.record.items.map((i) => i.uuid)).toEqual(['item-1']);
    // OEQ_SCHEMA_UUID describes the configured collection, never the record's other one.
    expect(got.fallbackSchemaUuid).toBe('');
  });

  it('searches the configured collection without it, lending it the configured schema', async () => {
    const got = await resolveIndexSource(null, site('https://oeq.example.edu', 'coll-configured'));
    expect(got).toEqual({ collectionUuid: 'coll-configured', source: { kind: 'collection' }, fallbackSchemaUuid: 'schema-configured' });
  });

  it('lends the configured schema to a record of the configured collection', async () => {
    const path = await save(record());
    const got = await resolveIndexSource([path], site('https://oeq.example.edu', 'coll-from-record'));
    expect(got.fallbackSchemaUuid).toBe('schema-configured');
  });

  it("matches the site however it is spelt: a trailing slash or the host's case", async () => {
    const path = await save(record({ baseUrl: 'https://OEQ.example.edu/' }));
    await expect(resolveIndexSource([path], site('https://oeq.example.edu', 'c'))).resolves.toBeDefined();
  });

  it('refuses a record of another site: its links would point at the wrong server', async () => {
    const path = await save(record({ baseUrl: 'https://oeq-test.example.edu' }));
    await expect(resolveIndexSource([path], site('https://oeq.example.edu', 'c'))).rejects.toThrow(ValidationError);
    await expect(resolveIndexSource([path], site('https://oeq.example.edu', 'c'))).rejects.toThrow(
      /oeq-test\.example\.edu.*oeq\.example\.edu/,
    );
  });

  it('refuses before signing in: indexAction never reaches the server', async () => {
    const path = await save(record({ baseUrl: 'https://oeq-test.example.edu' }));
    // Nothing listens on this port; reaching the network would fail differently.
    const env = {
      OEQ_BASE_URL: 'https://oeq.example.edu',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c',
    };
    await expect(indexAction({ template: 'unused.json', fromRecord: [path] }, env)).rejects.toThrow(
      /different site|another site/,
    );
  });
});
