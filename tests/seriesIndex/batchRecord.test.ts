import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveManifest, writeJsonAtomic } from '../../src/core/state.js';
import {
  keepBatchRecord,
  readBatchRecords,
  recordFromManifest,
  recordHits,
  type BatchRecord,
} from '../../src/core/seriesIndex/batchRecord.js';
import type { Manifest, ManifestEntry } from '../../src/core/types.js';

const now = new Date('2026-11-18T19:00:00.000Z');

const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
  rowNumber: 2,
  source: 'FQ_1970_Vol1_No1.pdf',
  files: [{ path: 'C:/batch/FQ_1970_Vol1_No1.pdf', name: 'FQ_1970_Vol1_No1.pdf' }],
  metadata: {},
  status: 'pending',
  attempts: 0,
  ...over,
});

const manifest = (entries: ManifestEntry[], over: Partial<Manifest> = {}): Manifest => ({
  version: 2,
  createdAt: '2026-11-18T18:00:00.000Z',
  baseUrl: 'https://oeq.example.edu',
  collectionUuid: 'c1',
  schemaUuid: 's1',
  itemState: 'draft',
  attachmentColumn: 'attachment name',
  entries,
  warnings: [],
  ...over,
});

const folderRow = entry({
  rowNumber: 3,
  source: 'Vol2',
  folderPath: 'C:/batch/Vol2',
  files: [
    { path: 'C:/batch/Vol2/FQ_1971_Vol2_No1.pdf', name: 'FQ_1971_Vol2_No1.pdf' },
    { path: 'C:/batch/Vol2/FQ_1971_Vol2_No2.pdf', name: 'FQ_1971_Vol2_No2.pdf' },
    { path: 'C:/batch/Vol2/FQ_1971_Vol2_No3.pdf', name: 'FQ_1971_Vol2_No3.pdf' },
  ],
  metadata: { 'DC/title': ['  Fernbrook Quarterly Vol 2  '] },
  status: 'created',
  itemUuid: 'item-2',
  itemVersion: 1,
  attachmentUuids: ['att-2a', 'att-2b', 'att-2c'],
  attempts: 1,
});

describe('recordFromManifest', () => {
  it('records a created folder row with its files in upload order', () => {
    const r = recordFromManifest(manifest([folderRow]), 'DC/title', now);
    expect(r).toEqual({
      kind: 'oeq-batch-record',
      version: 1,
      savedAt: '2026-11-18T19:00:00.000Z',
      baseUrl: 'https://oeq.example.edu',
      collectionUuid: 'c1',
      items: [
        {
          row: 3,
          uuid: 'item-2',
          version: 1,
          title: 'Fernbrook Quarterly Vol 2',
          label: 'Vol2 (3 files)',
          state: 'draft',
          files: [
            { name: 'FQ_1971_Vol2_No1.pdf', attachmentUuid: 'att-2a' },
            { name: 'FQ_1971_Vol2_No2.pdf', attachmentUuid: 'att-2b' },
            { name: 'FQ_1971_Vol2_No3.pdf', attachmentUuid: 'att-2c' },
          ],
        },
      ],
      leftOut: [],
    });
  });

  it('records no title when none is stated, so the index falls back to its own heading', () => {
    const noTitle = { ...folderRow, metadata: { 'DC/title': ['   '] } };
    expect(recordFromManifest(manifest([folderRow]), null, now).items[0]!.title).toBe('');
    expect(recordFromManifest(manifest([noTitle]), 'DC/title', now).items[0]!.title).toBe('');
    expect(recordFromManifest(manifest([folderRow]), 'DC/other', now).items[0]!.title).toBe('');
    expect(recordHits(recordFromManifest(manifest([folderRow]), null, now))[0]!.name).toBeNull();
  });

  it('records each item with its row label', () => {
    expect(recordFromManifest(manifest([folderRow]), 'DC/title', now).items[0]!.label).toBe('Vol2 (3 files)');
  });

  it('records an incomplete row that has an item as an item: it exists in openEQUELLA', () => {
    const r = recordFromManifest(
      manifest([
        { ...folderRow, status: 'incomplete', error: 'uuids differ' },
        entry({ rowNumber: 4, source: 'FQ_1972_Vol3_No1.pdf', status: 'incomplete', error: 'no item' }),
      ]),
      'DC/title',
      now,
    );
    expect(r.items.map((i) => i.uuid)).toEqual(['item-2']);
    expect(r.leftOut).toEqual([{ row: 4, label: 'FQ_1972_Vol3_No1.pdf', status: 'incomplete', error: 'no item' }]);
  });

  it('leaves out an incomplete row whose item kept FEWER files than were sent: the index would link to nothing', () => {
    const short = { ...folderRow, status: 'incomplete' as const, attachmentUuids: ['att-2a', 'att-2b'], error: 'kept 2 of 3' };
    const r = recordFromManifest(manifest([short]), 'DC/title', now);
    expect(r.items).toEqual([]);
    expect(r.leftOut).toEqual([{ row: 3, label: 'Vol2 (3 files)', status: 'incomplete', error: 'kept 2 of 3' }]);

    const { error: _e, ...silent } = short;
    expect(recordFromManifest(manifest([silent]), 'DC/title', now).leftOut).toEqual([
      { row: 3, label: 'Vol2 (3 files)', status: 'incomplete', error: 'openEQUELLA kept fewer files than were sent' },
    ]);
    // The same count, uuids differing: the item holds every file, so it is an item.
    const differ = { ...folderRow, status: 'incomplete' as const, attachmentUuids: ['x', 'y', 'z'] };
    expect(recordFromManifest(manifest([differ]), 'DC/title', now).items.map((i) => i.uuid)).toEqual(['item-2']);
  });

  it("records each new item's state, so a later run's drafts do not make earlier items read as drafts", () => {
    expect(recordFromManifest(manifest([folderRow], { itemState: 'published' }), null, now).items[0]!.state).toBe('published');
  });

  it('names every entry the run did not create -- an interrupted run included', () => {
    const r = recordFromManifest(
      manifest([
        entry({ rowNumber: 2, status: 'created', itemUuid: 'item-1', itemVersion: 1, attachmentUuids: ['att-1'] }),
        folderRow,
        entry({ rowNumber: 4, source: 'FQ_1972_Vol3_No1.pdf', status: 'failed', error: 'The server said no.' }),
        entry({ rowNumber: 5, source: 'FQ_1972_Vol3_No2.pdf', status: 'pending' }),
        entry({ rowNumber: 6, source: 'FQ_1972_Vol3_No3.pdf', status: 'created' }), // no uuid: not an item
      ]),
      'DC/title',
      now,
    );
    expect(r.items.map((i) => i.uuid)).toEqual(['item-1', 'item-2']);
    expect(r.items[0]!.title).toBe('');
    expect(r.leftOut).toEqual([
      { row: 4, label: 'FQ_1972_Vol3_No1.pdf', status: 'failed', error: 'The server said no.' },
      { row: 5, label: 'FQ_1972_Vol3_No2.pdf', status: 'pending' },
      { row: 6, label: 'FQ_1972_Vol3_No3.pdf', status: 'created' },
    ]);
  });

  it('records a missing attachment uuid as empty, and a missing version as 1', () => {
    const r = recordFromManifest(manifest([{ ...folderRow, attachmentUuids: ['att-2a'], itemVersion: undefined }]), null, now);
    expect(r.items[0]!.version).toBe(1);
    expect(r.items[0]!.files.map((f) => f.attachmentUuid)).toEqual(['att-2a', '', '']);
  });
});

describe('recordHits', () => {
  it("turns each item into a search hit, with the item's state as its status", () => {
    const r = recordFromManifest(manifest([folderRow]), 'DC/title', now);
    expect(recordHits(r)).toEqual([
      {
        uuid: 'item-2',
        version: 1,
        status: 'draft',
        name: 'Fernbrook Quarterly Vol 2',
        label: 'Vol2 (3 files)',
        files: [
          { filename: 'FQ_1971_Vol2_No1.pdf', uuid: 'att-2a' },
          { filename: 'FQ_1971_Vol2_No2.pdf', uuid: 'att-2b' },
          { filename: 'FQ_1971_Vol2_No3.pdf', uuid: 'att-2c' },
        ],
      },
    ]);
  });

  it("reads each item's own state", () => {
    const r = recordFromManifest(manifest([folderRow]), 'DC/title', now);
    const live = { ...r.items[0]!, uuid: 'item-1', state: 'published' as const };
    expect(recordHits({ ...r, items: [live, r.items[0]!] }).map((h) => h.status)).toEqual([
      'live',
      'draft',
    ]);
  });

  it('gives an untitled item no name -- the heading falls back -- but its label, for listings', () => {
    const r = recordFromManifest(manifest([{ ...folderRow, metadata: {} }]), 'DC/title', now);
    expect(recordHits(r)[0]).toMatchObject({ name: null, label: 'Vol2 (3 files)' });
  });
});

describe('readBatchRecords', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oeq-batch-record-'));
  });

  const record = (over: Partial<BatchRecord> = {}): BatchRecord => ({
    ...recordFromManifest(manifest([folderRow]), 'DC/title', now),
    ...over,
  });

  it('round-trips, leaving no temporary file behind', async () => {
    const path = join(dir, 'batch.index.json');
    await writeJsonAtomic(path, record());
    await writeJsonAtomic(path, record()); // replaces, as a run does after every row
    expect(await readdir(dir)).toEqual(['batch.index.json']);
    expect(await readBatchRecords([path])).toEqual(record());
  });

  it('combines several records in order, listing a uuid once', async () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    const other = { ...record().items[0]!, row: 2, uuid: 'item-9', title: 'Fernbrook Quarterly Vol 9' };
    await writeJsonAtomic(a, record({ leftOut: [{ row: 7, label: 'x.pdf', status: 'failed', error: 'e' }] }));
    await writeJsonAtomic(b, record({ baseUrl: 'https://oeq.example.edu/', items: [other, record().items[0]!] }));
    const both = await readBatchRecords([a, b]);
    expect(both.items.map((i) => i.uuid).sort()).toEqual(['item-2', 'item-9']);
    expect(both.leftOut).toEqual([{ row: 7, label: 'x.pdf', status: 'failed', error: 'e' }]);
    expect(both.baseUrl).toBe('https://oeq.example.edu');
  });

  it('lets the LATER record win for a uuid two records carry, as a rerun keeping its record does', async () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    const first = record().items[0]!;
    const later = { ...first, version: 2, files: [{ name: 'FQ_1971_Vol2_All.pdf', attachmentUuid: 'att-new' }] };
    await writeJsonAtomic(a, record());
    await writeJsonAtomic(b, record({ items: [later] }));
    expect((await readBatchRecords([a, b])).items).toEqual([later]);
    expect((await readBatchRecords([b, a])).items).toEqual([first]);
  });

  it('refuses an item without a state or a label, or with a state it does not know', async () => {
    const path = join(dir, 'old.json');
    const { state: _s, ...stateless } = record().items[0]!;
    const { label: _l, ...unlabelled } = record().items[0]!;
    for (const item of [stateless, unlabelled, { ...stateless, state: 'live' }]) {
      await writeFile(path, JSON.stringify(record({ items: [item as never] })));
      await expect(readBatchRecords([path])).rejects.toThrow(/old\.json/);
    }
  });

  it('refuses a file that is not a batch record, naming it', async () => {
    const manifestFile = join(dir, 'job.json');
    await writeFile(manifestFile, JSON.stringify(manifest([folderRow])));
    await expect(readBatchRecords([manifestFile])).rejects.toThrow(/job\.json.*not a batch record/);
  });

  it('refuses an unknown version, naming the file', async () => {
    const path = join(dir, 'future.json');
    await writeFile(path, JSON.stringify({ ...record(), version: 2 }));
    await expect(readBatchRecords([path])).rejects.toThrow(/future\.json.*version/);
  });

  it('refuses unreadable JSON and a missing file, naming each', async () => {
    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{"kind": "oeq-batch-');
    await expect(readBatchRecords([broken])).rejects.toThrow(/broken\.json/);
    await expect(readBatchRecords([join(dir, 'absent.json')])).rejects.toThrow(/absent\.json/);
  });

  it('refuses records of different sites or collections', async () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    await writeJsonAtomic(a, record());
    await writeJsonAtomic(b, record({ baseUrl: 'https://other.example.edu' }));
    await expect(readBatchRecords([a, b])).rejects.toThrow(/b\.json.*site/);
    await writeJsonAtomic(b, record({ collectionUuid: 'c2' }));
    await expect(readBatchRecords([a, b])).rejects.toThrow(/b\.json.*collection/);
  });

  it('refuses an empty list of records', async () => {
    await expect(readBatchRecords([])).rejects.toThrow(/no batch record/i);
  });

  it('compares sites as one spelling: host case and a trailing slash do not differ', async () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    await writeJsonAtomic(a, record());
    await writeJsonAtomic(b, record({ baseUrl: 'https://OEQ.Example.edu/' }));
    await expect(readBatchRecords([a, b])).resolves.toBeDefined();
  });

  it('drops a left-out row that another record created, so the two do not contradict', async () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    const failed = { row: 3, label: 'Vol2 (3 files)', status: 'failed' as const, error: 'The server said no.' };
    const other = { row: 9, label: 'Vol9', status: 'failed' as const };
    await writeJsonAtomic(a, record({ items: [], leftOut: [failed, other] }));
    await writeJsonAtomic(b, record()); // the retry created row 3
    const both = await readBatchRecords([a, b]);
    expect(both.items.map((i) => i.uuid)).toEqual(['item-2']);
    expect(both.leftOut).toEqual([other]);
  });

  it.each([
    ['an item without a uuid', { items: [{ row: 3, version: 1, title: '', files: [] }] }],
    ['an item whose version is text', { items: [{ row: 3, uuid: 'u', version: '1', title: '', files: [] }] }],
    ['an item whose files are not a list', { items: [{ row: 3, uuid: 'u', version: 1, title: '', files: 'a.pdf' }] }],
    ['a file without a name', { items: [{ row: 3, uuid: 'u', version: 1, title: '', files: [{ attachmentUuid: 'a' }] }] }],
    ['a label that is not text', { items: [{ row: 3, uuid: 'u', version: 1, title: '', label: 3, files: [] }] }],
    ['an item that is not an object', { items: [null] }],
    ['a left-out row whose row is text', { leftOut: [{ row: '3', label: 'x', status: 'failed' }] }],
    ['a left-out row without a status', { leftOut: [{ row: 3, label: 'x' }] }],
    ['a left-out error that is not text', { leftOut: [{ row: 3, label: 'x', status: 'failed', error: 4 }] }],
  ])('refuses %s, naming the file', async (_what, over) => {
    const path = join(dir, 'damaged.json');
    await writeFile(path, JSON.stringify({ ...record(), ...over }));
    await expect(readBatchRecords([path])).rejects.toThrow(/damaged\.json/);
  });
});

describe('keepBatchRecord', () => {
  let dir: string;
  let manifestPath: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oeq-keeper-'));
    manifestPath = join(dir, 'job.json');
    file = join(dir, 'batch.index.json');
  });
  const read = (): BatchRecord => JSON.parse(readFileSync(file, 'utf8')) as BatchRecord;
  const created = (rowNumber: number, uuid: string, source: string): ManifestEntry =>
    entry({ rowNumber, source, status: 'created', itemUuid: uuid, itemVersion: 1, attachmentUuids: [`${uuid}-a`] });

  it("carries an earlier run's items forward, this run's version winning, rather than replacing them", async () => {
    // The first run of this spreadsheet created rows 2 and 3; row 4 failed.
    await saveManifest(
      manifestPath,
      manifest([
        created(2, 'item-1', 'one.pdf'),
        created(3, 'item-3', 'three.pdf'),
        entry({ rowNumber: 4, source: 'four.pdf', status: 'failed', error: 'no' }),
      ]),
    );
    const first = keepBatchRecord(manifestPath, file, null);
    first.update();
    expect((await first.settled()).written).toBe(true);

    // A later run of the same spreadsheet: a new job, in which row 4 was created.
    await saveManifest(
      manifestPath,
      manifest([
        entry({ rowNumber: 2, source: 'one.pdf', status: 'skipped' }),
        { ...created(3, 'item-3', 'three.pdf'), itemVersion: 2 },
        created(4, 'item-4', 'four.pdf'),
      ]),
    );
    const second = keepBatchRecord(manifestPath, file, null);
    second.update();
    expect((await second.settled()).written).toBe(true);
    const r = read();
    expect(r.items.map((i) => [i.uuid, i.version])).toEqual([
      ['item-1', 1],
      ['item-3', 2],
      ['item-4', 1],
    ]);
    // Row 2 is listed as created by the earlier run, so it is not also "left out".
    expect(r.leftOut).toEqual([]);
  });

  it("keeps each item's own state, so a later run's drafts leave earlier published items published", async () => {
    await saveManifest(manifestPath, manifest([created(2, 'item-1', 'one.pdf')], { itemState: 'published' }));
    const first = keepBatchRecord(manifestPath, file, null);
    first.update();
    await first.settled();
    await saveManifest(manifestPath, manifest([created(3, 'item-3', 'three.pdf')], { itemState: 'draft' }));
    const second = keepBatchRecord(manifestPath, file, null);
    second.update();
    await second.settled();
    expect(recordHits(read()).map((h) => [h.uuid, h.status])).toEqual([
      ['item-1', 'live'],
      ['item-3', 'draft'],
    ]);
  });

  it.each([
    ['is not a batch record', '{"some": "other file"}', /not a batch record/],
    ['is not JSON at all', 'notes the operator kept', /not a batch record/],
    ['records another site', null, /another site/],
    ['records another collection', 'collection', /another collection/],
  ])('leaves a file that %s alone, and says so', async (_what, content, reason) => {
    const m = manifest([created(2, 'item-1', 'one.pdf')]);
    let text: string;
    if (content === null) text = JSON.stringify(recordFromManifest({ ...m, baseUrl: 'https://other.example.edu' }, null));
    else if (content === 'collection') text = JSON.stringify(recordFromManifest({ ...m, collectionUuid: 'c9' }, null));
    else text = content;
    await writeFile(file, text);
    await saveManifest(manifestPath, m);
    const failures: unknown[] = [];
    const keeper = keepBatchRecord(manifestPath, file, null, (err) => failures.push(err));
    keeper.update();
    const kept = await keeper.settled();
    expect(kept.written).toBe(false);
    expect(String((kept.error as Error).message)).toMatch(reason);
    expect(String((kept.error as Error).message)).toContain('batch.index.json');
    expect(failures).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('writes nothing for a progress report whose row status has not changed', async () => {
    await saveManifest(manifestPath, manifest([created(2, 'item-1', 'one.pdf'), entry({ rowNumber: 3, source: 'two.pdf' })]));
    const keeper = keepBatchRecord(manifestPath, file, null);
    // A retry reports already-created rows back to back: nothing to write.
    keeper.update({ rowNumber: 2, status: 'created' });
    await keeper.settled();
    expect(existsSync(file)).toBe(false);
    // Row 3 changed: written, from the manifest the report carries.
    const later = manifest([created(2, 'item-1', 'one.pdf'), created(3, 'item-3', 'two.pdf')]);
    keeper.update({ rowNumber: 3, status: 'created' }, later);
    await keeper.settled();
    expect(read().items).toHaveLength(2);
    // The same report again: nothing written.
    await rm(file);
    keeper.update({ rowNumber: 3, status: 'created' }, later);
    await keeper.settled();
    expect(existsSync(file)).toBe(false);
    // The final update always writes, from the last manifest reported.
    keeper.update();
    expect((await keeper.settled()).written).toBe(true);
    expect(read().items).toHaveLength(2);
  });

  it('never reads the manifest back after it starts: the report carries it', async () => {
    await saveManifest(manifestPath, manifest([entry({ rowNumber: 2, source: 'one.pdf' })]));
    const keeper = keepBatchRecord(manifestPath, file, null);
    await rm(manifestPath);
    keeper.update({ rowNumber: 2, status: 'created' }, manifest([created(2, 'item-1', 'one.pdf')]));
    expect((await keeper.settled()).written).toBe(true);
    expect(read().items.map((i) => i.uuid)).toEqual(['item-1']);
  });

  it('writes only the latest record when several are queued', async () => {
    await saveManifest(manifestPath, manifest([entry({ rowNumber: 2, source: 'one.pdf' }), entry({ rowNumber: 3, source: 'two.pdf' })]));
    const keeper = keepBatchRecord(manifestPath, file, null);
    keeper.update({ rowNumber: 2, status: 'created' }, manifest([created(2, 'item-1', 'one.pdf'), entry({ rowNumber: 3, source: 'two.pdf' })]));
    keeper.update({ rowNumber: 3, status: 'created' }, manifest([created(2, 'item-1', 'one.pdf'), created(3, 'item-3', 'two.pdf')]));
    expect((await keeper.settled()).written).toBe(true);
    expect(read().items.map((i) => i.uuid)).toEqual(['item-1', 'item-3']);
  });

  it('reports written:false when the LAST update failed, though an earlier write landed after it', async () => {
    await saveManifest(manifestPath, manifest([entry({ rowNumber: 2, source: 'one.pdf' })]));
    const keeper = keepBatchRecord(manifestPath, file, null);
    keeper.update(); // queues a write that lands later
    // A manifest the record cannot be built from: the update fails, synchronously.
    keeper.update({ rowNumber: 2, status: 'created' }, { ...manifest([]), entries: null } as never);
    const kept = await keeper.settled();
    expect(kept.written).toBe(false);
    expect(kept.error).not.toBeNull();
  });
});
