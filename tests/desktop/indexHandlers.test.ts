import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexHandlers, type IndexConnection } from '../../src/desktop/indexHandlers.js';
import { writeBatchRecord, type BatchRecord } from '../../src/core/seriesIndex/batchRecord.js';

async function templatesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-tpl-'));
  await mkdir(dir, { recursive: true });
  const base = {
    version: 1,
    pattern: 'FQ_Vol{group}',
    columns: [{ path: 'attachment name', sources: [{ filename: true }] }],
    checks: { sequence: { patterns: ['{year}_Vol{group}_No{part}'], labels: { part: 'issue', group: 'volume' } } },
  };
  await writeFile(
    join(dir, 'with-index.profile.json'),
    JSON.stringify({
      ...base,
      index: {
        columns: [
          { path: 'DC/title', value: 'Fernbrook index' },
          { path: 'DC/description', value: 'Every volume.' },
          { path: 'DC/identifier', value: 'FQ_index' },
        ],
      },
    }),
  );
  await writeFile(join(dir, 'without-index.profile.json'), JSON.stringify(base));
  return dir;
}

function connect(over: Record<string, unknown> = {}) {
  const created: unknown[] = [];
  const calls = { edit: 0, search: 0 };
  const client = {
    currentUser: async () => ({ id: 'u', username: 'u', firstName: '', lastName: '', guest: false }),
    getCollection: async () => ({ uuid: 'c1', name: 'C', schemaUuid: 's1' }),
    getSchema: async () => ({
      uuid: 's1',
      namePath: '/DC/title',
      titleHeader: 'DC/title',
      descriptionPath: '/DC/description',
      descriptionHeader: 'DC/description',
      paths: new Set(['DC/title', 'DC/description', 'DC/identifier']),
    }),
    searchCollection: async () => calls.search++ >= 0 && [
      { uuid: 'v1', version: 1, status: 'draft', name: 'Fernbrook Vol 1', attachments: [{ type: 'file', filename: 'FQ_1971_Vol1_No1.pdf', uuid: 'a' }] },
    ],
    findByField: async () => [],
    createStagingArea: async () => 'stg',
    uploadToStaging: async () => {},
    deleteStagingArea: async () => {},
    createItem: async (req: unknown) => (created.push(req), { uuid: 'new', version: 1, attachmentUuids: [] }),
    getItemBean: async () => ({}),
    editItem: async () => {
      calls.edit++;
    },
    ...over,
  };
  // The fake implements only what the flow calls; the cast says so once.
  return {
    created,
    calls,
    deps: async (): Promise<IndexConnection> => ({
      client: client as unknown as IndexConnection['client'],
      baseUrl: 'https://oeq.example.edu',
      fallbackSchemaUuid: '',
      setupCollectionUuid: '',
    }),
  };
}

describe('index handlers', () => {
  it('offers only templates that can build an index', async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps });
    expect((await h.templates()).map((t) => t.id)).toEqual(['with-index']);
  });

  it('skips a template that will not load, naming it, and still offers the rest', async () => {
    const dir = await templatesDir();
    await writeFile(join(dir, 'broken.profile.json'), '{ not json');
    const warned: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      const h = createIndexHandlers({ templatesDir: dir, connect: connect().deps });
      expect((await h.templates()).map((t) => t.id)).toEqual(['with-index']);
    } finally {
      console.warn = original;
    }
    expect(warned).toHaveLength(1);
    expect(String(warned[0]!.join(' '))).toMatch(/broken/);
  });

  it('previews, then uploads THE SAME build by id', async () => {
    const c = connect();
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    const preview = await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect(preview).toMatchObject({
      buildId: 'b1',
      title: 'Fernbrook index',
      volumes: [{ heading: 'Fernbrook Vol 1', issues: ['Issue 1 (1971)'] }],
      issueCount: 1,
      existing: { kind: 'none' },
    });
    const up = await h.upload({ buildId: 'b1', draft: true });
    expect(up).toEqual({ kind: 'created', url: 'https://oeq.example.edu/items/new/0/index.html', status: 'draft' });
    expect(c.created[0]).toMatchObject({ draft: true });
  });

  it('carries the volume numbers nothing lists to the preview', async () => {
    const vol = (n: number) => ({
      uuid: `v${n}`,
      version: 1,
      status: 'live',
      name: `Fernbrook Vol ${n}`,
      attachments: [{ type: 'file', filename: `FQ_1971_Vol${n}_No1.pdf`, uuid: `a${n}` }],
    });
    const c = connect({ searchCollection: async () => [vol(9), vol(12)] });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    expect(await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' })).toMatchObject({
      missing: [10, 11],
      missingCount: 2,
    });
  });

  it('sends at most 20 missing numbers to the renderer, with how many there are', async () => {
    const vol = (n: number) => ({
      uuid: `v${n}`,
      version: 1,
      status: 'live',
      name: `Fernbrook Vol ${n}`,
      attachments: [{ type: 'file', filename: `FQ_1971_Vol${n}_No1.pdf`, uuid: `a${n}` }],
    });
    const c = connect({ searchCollection: async () => [vol(38), vol(270)] });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    const p = await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect(p.missing).toEqual(Array.from({ length: 20 }, (_, i) => 39 + i));
    expect(p.missingCount).toBe(231);
  });

  it('a second upload updates the item the first one created', async () => {
    const c = connect();
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect((await h.upload({ buildId: 'b1', draft: true })).kind).toBe('created');
    expect((await h.upload({ buildId: 'b1', draft: true })).kind).toBe('updated');
    expect(c.created).toHaveLength(1);
    expect(c.calls.edit).toBe(1);
  });

  it('a failed preview leaves no usable build', async () => {
    let n = 0;
    const c = connect();
    const good = await c.deps();
    const deps = async (): Promise<IndexConnection> => {
      if (++n === 1) return good;
      return {
        ...good,
        client: {
          ...good.client,
          getSchema: async () => {
            throw new Error('boom');
          },
        } as IndexConnection['client'],
      };
    };
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    await expect(h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' })).rejects.toThrow();
    await expect(h.upload({ buildId: 'b1', draft: true })).rejects.toThrow(/Preview again/);
  });

  it('a guest session rejects the preview before any search', async () => {
    const c = connect({
      currentUser: async () => ({ id: 'g', username: 'guest', firstName: '', lastName: '', guest: true }),
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps });
    await expect(h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' })).rejects.toThrow();
    expect(c.calls.search).toBe(0);
  });

  it('refuses an unknown or superseded build id', async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps });
    await expect(h.upload({ buildId: 'nope', draft: true })).rejects.toThrow(/Preview again/);
  });

  it('after an upload, links each LISTED volume to the new index item', async () => {
    const edits: { uuid: string; bean: Record<string, unknown> }[] = [];
    const c = connect({
      getItemBean: async (uuid: string) => ({ uuid, attachments: [{ type: 'file', filename: 'FQ_1971_Vol1_No1.pdf', uuid: 'a' }] }),
      editItem: async (uuid: string, _v: number, bean: Record<string, unknown>) => {
        edits.push({ uuid, bean });
      },
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    await h.upload({ buildId: 'b1', draft: true });
    expect(await h.linkVolumes({ buildId: 'b1' })).toEqual({ added: 1, updated: 0, alreadyThere: 0, failed: [] });
    expect(edits.map((e) => e.uuid)).toEqual(['v1']);
    expect((edits[0]!.bean['attachments'] as unknown[])[0]).toEqual({
      type: 'url',
      url: 'https://oeq.example.edu/items/new/0/index.html',
      description: 'Index of all volumes',
    });
  });

  it("gives the renderer the template's own words", async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps, newId: () => 'b1' });
    const preview = await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect(preview.labels).toEqual({ part: 'issue', parts: 'issues', group: 'volume', groups: 'volumes' });
  });

  it('never links a held-back item, only the listed volumes', async () => {
    const edited: string[] = [];
    const c = connect({
      searchCollection: async () => [
        { uuid: 'v1', version: 1, status: 'live', name: 'Fernbrook Vol 1', attachments: [{ type: 'file', filename: 'FQ_1971_Vol1_No1.pdf', uuid: 'a' }] },
        {
          uuid: 'held',
          version: 1,
          status: 'live',
          name: 'Fernbrook mixed',
          attachments: [
            { type: 'file', filename: 'FQ_1972_Vol2_No1.pdf', uuid: 'b' },
            { type: 'file', filename: 'FQ_1973_Vol3_No1.pdf', uuid: 'c' },
          ],
        },
      ],
      getItemBean: async () => ({ attachments: [] }),
      editItem: async (uuid: string) => {
        edited.push(uuid);
      },
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    const preview = await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect(preview.heldBack).toHaveLength(1);
    await h.upload({ buildId: 'b1', draft: true });
    expect(await h.linkVolumes({ buildId: 'b1' })).toEqual({ added: 1, updated: 0, alreadyThere: 0, failed: [] });
    expect(edited).toEqual(['v1']);
  });

  it('refuses to link volumes before the index item exists', async () => {
    const c = connect();
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    await expect(h.linkVolumes({ buildId: 'b1' })).rejects.toThrow(/Upload the index item first/);
    expect(c.calls.edit).toBe(0);
  });

  it('links to an index item that already existed at preview time', async () => {
    const edits: string[] = [];
    const c = connect({
      findByField: async () => [{ uuid: 'old', version: 2, status: 'live', name: 'Fernbrook index', attachments: [] }],
      getItemBean: async () => ({ attachments: [] }),
      editItem: async (uuid: string, _v: number, bean: Record<string, unknown>) => {
        edits.push(`${uuid} ${JSON.stringify((bean['attachments'] as { url?: string }[])[0]?.url)}`);
      },
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    await h.linkVolumes({ buildId: 'b1' });
    expect(edits).toEqual(['v1 "https://oeq.example.edu/items/old/0/index.html"']);
  });

  it('every upload and link signs in afresh, never reusing the preview connection', async () => {
    const c = connect({
      getItemBean: async () => ({ attachments: [] }),
    });
    let n = 0;
    const deps = async (id: string) => {
      n++;
      expect(id).toBe('i');
      return c.deps();
    };
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect(n).toBe(1);
    await h.upload({ buildId: 'b1', draft: true });
    expect(n).toBe(2);
    await h.linkVolumes({ buildId: 'b1' });
    expect(n).toBe(3);
  });

  it('a session that is guest by upload time refuses before any write', async () => {
    const writes: string[] = [];
    let guest = false;
    const c = connect({
      currentUser: async () => ({ id: 'u', username: guest ? 'guest' : 'u', firstName: '', lastName: '', guest }),
      createStagingArea: async () => (writes.push('stage'), 'stg'),
      editItem: async () => {
        writes.push('edit');
      },
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    guest = true;
    await expect(h.upload({ buildId: 'b1', draft: true })).rejects.toThrow();
    await expect(h.linkVolumes({ buildId: 'b1' })).rejects.toThrow();
    expect(writes).toEqual([]);
    expect(c.created).toEqual([]);
  });

  it('an index item created since the preview is UPDATED, not duplicated', async () => {
    let appeared = false;
    const c = connect({
      findByField: async () =>
        appeared ? [{ uuid: 'other', version: 3, status: 'live', name: 'Fernbrook index', attachments: [] }] : [],
      getItemBean: async () => ({ metadata: '<xml/>', attachments: [] }),
    });
    const edited: string[] = [];
    const client = (await c.deps()).client;
    const deps = async (): Promise<IndexConnection> => ({
      ...(await c.deps()),
      client: {
        ...client,
        editItem: async (uuid: string) => {
          edited.push(uuid);
        },
      } as IndexConnection['client'],
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: deps, newId: () => 'b1' });
    const preview = await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect(preview.existing).toEqual({ kind: 'none' });
    appeared = true;
    const up = await h.upload({ buildId: 'b1', draft: true });
    expect(up).toEqual({ kind: 'updated', url: 'https://oeq.example.edu/items/other/0/index.html', status: 'live' });
    expect(c.created).toEqual([]);
    expect(edited).toEqual(['other']);
  });

  it('refuses an upload when several index items have appeared since the preview', async () => {
    let appeared = false;
    const c = connect({
      findByField: async () =>
        appeared
          ? [
              { uuid: 'x', version: 1, status: 'live', name: 'X', attachments: [] },
              { uuid: 'y', version: 1, status: 'live', name: 'Y', attachments: [] },
            ]
          : [],
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    appeared = true;
    await expect(h.upload({ buildId: 'b1', draft: true })).rejects.toThrow(/X, Y/);
    expect(c.created).toEqual([]);
  });

  it('only the latest-started preview is held, even when an older one finishes last', async () => {
    const c = connect();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const deps = async (): Promise<IndexConnection> => {
      if (++n === 1) await gate; // the first preview stalls until the second is done
      return c.deps();
    };
    const ids = ['b1', 'b2'];
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: deps, newId: () => ids.shift()! });
    const first = h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    const second = await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    release();
    const older = await first;
    expect(second.buildId).not.toBe(older.buildId);
    await expect(h.upload({ buildId: older.buildId, draft: true })).rejects.toThrow(/Preview again/);
    expect((await h.upload({ buildId: second.buildId, draft: true })).kind).toBe('created');
  });

  describe("Setup's schema, for a collection that names none", () => {
    const schemaless = async (collectionUuid: string) => {
      const asked: string[] = [];
      const c = connect({
        getCollection: async (uuid: string) => ({ uuid, name: 'C' }),
        getSchema: async (uuid: string) => {
          asked.push(uuid);
          return {
            uuid,
            namePath: '/DC/title',
            titleHeader: 'DC/title',
            descriptionPath: '/DC/description',
            descriptionHeader: 'DC/description',
            paths: new Set(['DC/title', 'DC/description', 'DC/identifier']),
          };
        },
      });
      const deps = async (): Promise<IndexConnection> => ({
        ...(await c.deps()),
        fallbackSchemaUuid: 'setup-schema',
        setupCollectionUuid: 'setup-coll',
      });
      const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: deps, newId: () => 'b1' });
      return { asked, run: () => h.preview({ instanceId: 'i', collectionUuid, templateId: 'with-index' }) };
    };

    it('is used for the collection Setup read it from', async () => {
      const s = await schemaless('setup-coll');
      await s.run();
      expect(s.asked).toEqual(['setup-schema']);
    });

    it('is never borrowed by another collection', async () => {
      const s = await schemaless('other-coll');
      await expect(s.run()).rejects.toThrow(/did not say which schema/);
      expect(s.asked).toEqual([]);
    });
  });

  it('saves the build to a folder, reporting files already there', async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    const dir = await mkdtemp(join(tmpdir(), 'oeq-out-'));
    expect((await h.saveFiles({ buildId: 'b1', dir, replace: false })).kind).toBe('saved');
    expect(await h.saveFiles({ buildId: 'b1', dir, replace: false })).toEqual({
      kind: 'exists',
      names: ['index.html', 'index.css', 'index.js'],
    });
  });
});

describe('index handlers, from batch records', () => {
  const record = (over: Partial<BatchRecord> = {}): BatchRecord => ({
    kind: 'oeq-batch-record',
    version: 1,
    savedAt: '2026-11-18T19:00:00.000Z',
    baseUrl: 'https://oeq.example.edu',
    collectionUuid: 'coll-rec',
    itemState: 'draft',
    items: [
      { row: 2, uuid: 'v1', version: 1, title: 'Fernbrook Vol 1', files: [{ name: 'FQ_1971_Vol1_No1.pdf', attachmentUuid: 'a' }] },
    ],
    leftOut: [{ row: 3, label: 'FQ_1972_Vol2_No1.pdf', status: 'failed', error: 'server said no' }],
    ...over,
  });
  const save = async (r: BatchRecord): Promise<string> => {
    const path = join(await mkdtemp(join(tmpdir(), 'oeq-rec-')), 'fernbrook.index.json');
    await writeBatchRecord(path, r);
    return path;
  };

  it('builds from the record with no search of the collection, and names what the run did not create', async () => {
    const collections: string[] = [];
    const c = connect({
      searchCollection: async () => {
        throw new Error('the record route must not search the collection');
      },
      getCollection: async (uuid: string) => (collections.push(uuid), { uuid, name: 'C', schemaUuid: 's1' }),
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    const preview = await h.preview({ instanceId: 'i', recordPaths: [await save(record())], templateId: 'with-index' });
    expect(preview.volumes).toEqual([{ heading: 'Fernbrook Vol 1', issues: ['Issue 1 (1971)'] }]);
    expect(preview.notCreated).toEqual([{ label: 'FQ_1972_Vol2_No1.pdf', status: 'failed', error: 'server said no' }]);
    // The RECORD's collection drives the schema and, below, the upload.
    expect(collections).toEqual(['coll-rec']);
    await h.upload({ buildId: 'b1', draft: true });
    expect(c.created[0]).toMatchObject({ collectionUuid: 'coll-rec' });
  });

  it("refuses another site's record before signing in", async () => {
    let connected = 0;
    const c = connect();
    const deps = async (): Promise<IndexConnection> => (connected++, c.deps());
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: deps });
    const path = await save(record({ baseUrl: 'https://oeq-test.example.edu' }));
    await expect(h.preview({ instanceId: 'i', recordPaths: [path], templateId: 'with-index' })).rejects.toThrow(
      /different site.*oeq-test\.example\.edu/,
    );
    // One connection, to learn the site's address; no sign-in check and no search.
    expect(connected).toBe(1);
    expect(c.calls.search).toBe(0);
  });

  it('matches the site however it is spelt', async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps });
    const path = await save(record({ baseUrl: 'https://OEQ.example.edu/' }));
    await expect(h.preview({ instanceId: 'i', recordPaths: [path], templateId: 'with-index' })).resolves.toBeDefined();
  });

  it('a collection preview names nothing as not created', async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps, newId: () => 'b1' });
    const preview = await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect(preview.notCreated).toEqual([]);
  });

  it("lends Setup's schema only when the record's collection is the one Setup read it from", async () => {
    const asked: string[] = [];
    const c = connect({
      getCollection: async (uuid: string) => ({ uuid, name: 'C' }),
      getSchema: async (uuid: string) => {
        asked.push(uuid);
        return {
          uuid,
          namePath: '/DC/title',
          titleHeader: 'DC/title',
          descriptionPath: '/DC/description',
          descriptionHeader: 'DC/description',
          paths: new Set(['DC/title', 'DC/description', 'DC/identifier']),
        };
      },
    });
    const deps = async (): Promise<IndexConnection> => ({
      ...(await c.deps()),
      fallbackSchemaUuid: 'setup-schema',
      setupCollectionUuid: 'setup-coll',
    });
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: deps });
    await expect(
      h.preview({ instanceId: 'i', recordPaths: [await save(record())], templateId: 'with-index' }),
    ).rejects.toThrow(/did not say which schema/);
    expect(asked).toEqual([]);
    await h.preview({ instanceId: 'i', recordPaths: [await save(record({ collectionUuid: 'setup-coll' }))], templateId: 'with-index' });
    expect(asked).toEqual(['setup-schema']);
  });
});
