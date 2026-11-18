import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readBatchRecords,
  recordFromManifest,
  recordHits,
  writeBatchRecord,
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
      itemState: 'draft',
      items: [
        {
          row: 3,
          uuid: 'item-2',
          version: 1,
          title: 'Fernbrook Quarterly Vol 2',
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

  it('falls back to the row label when there is no title path or no title', () => {
    const noTitle = { ...folderRow, metadata: { 'DC/title': ['   '] } };
    expect(recordFromManifest(manifest([folderRow]), null, now).items[0]!.title).toBe('Vol2 (3 files)');
    expect(recordFromManifest(manifest([noTitle]), 'DC/title', now).items[0]!.title).toBe('Vol2 (3 files)');
    expect(recordFromManifest(manifest([folderRow]), 'DC/other', now).items[0]!.title).toBe('Vol2 (3 files)');
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
    expect(r.items[0]!.title).toBe('FQ_1970_Vol1_No1.pdf');
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
  it('turns each item into a search hit, with the record state as its status', () => {
    const r = recordFromManifest(manifest([folderRow]), 'DC/title', now);
    expect(recordHits(r)).toEqual([
      {
        uuid: 'item-2',
        version: 1,
        status: 'draft',
        name: 'Fernbrook Quarterly Vol 2',
        files: [
          { filename: 'FQ_1971_Vol2_No1.pdf', uuid: 'att-2a' },
          { filename: 'FQ_1971_Vol2_No2.pdf', uuid: 'att-2b' },
          { filename: 'FQ_1971_Vol2_No3.pdf', uuid: 'att-2c' },
        ],
      },
    ]);
    expect(recordHits({ ...r, itemState: 'published' })[0]!.status).toBe('live');
  });
});

describe('writeBatchRecord / readBatchRecords', () => {
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
    await writeBatchRecord(path, record());
    await writeBatchRecord(path, record()); // replaces, as a run does after every row
    expect(await readdir(dir)).toEqual(['batch.index.json']);
    expect(await readBatchRecords([path])).toEqual(record());
  });

  it('combines several records in order, listing a uuid once and keeping draft if any is draft', async () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    const other = { ...record().items[0]!, row: 2, uuid: 'item-9', title: 'Fernbrook Quarterly Vol 9' };
    await writeBatchRecord(a, record({ itemState: 'published', leftOut: [{ row: 7, label: 'x.pdf', status: 'failed', error: 'e' }] }));
    await writeBatchRecord(b, record({ baseUrl: 'https://oeq.example.edu/', items: [other, record().items[0]!] }));
    const both = await readBatchRecords([a, b]);
    expect(both.items.map((i) => i.uuid)).toEqual(['item-2', 'item-9']);
    expect(both.leftOut).toEqual([{ row: 7, label: 'x.pdf', status: 'failed', error: 'e' }]);
    expect(both.itemState).toBe('draft');
    expect(both.baseUrl).toBe('https://oeq.example.edu');

    await writeBatchRecord(b, record({ itemState: 'published', items: [other] }));
    expect((await readBatchRecords([a, b])).itemState).toBe('published');
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
    await writeBatchRecord(a, record());
    await writeBatchRecord(b, record({ baseUrl: 'https://other.example.edu' }));
    await expect(readBatchRecords([a, b])).rejects.toThrow(/b\.json.*site/);
    await writeBatchRecord(b, record({ collectionUuid: 'c2' }));
    await expect(readBatchRecords([a, b])).rejects.toThrow(/b\.json.*collection/);
  });

  it('refuses an empty list of records', async () => {
    await expect(readBatchRecords([])).rejects.toThrow(/no batch record/i);
  });
});
