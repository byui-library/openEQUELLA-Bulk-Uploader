import { describe, it, expect } from 'vitest';
import { findExistingIndex, publishIndex, type IndexClient } from '../../src/core/seriesIndex/publish.js';
import type { IndexRecord } from '../../src/core/seriesIndex/record.js';
import type { CollectionItem } from '../../src/core/client.js';

const record: IndexRecord = {
  title: 'Fernbrook index',
  description: 'Every volume.',
  fields: { 'DC/title': ['Fernbrook index'], 'DC/identifier': ['FQ_index'] },
  identifier: { path: 'DC/identifier', value: 'FQ_index' },
  identifierProblem: null,
};
const files = { 'index.html': '<h1>x</h1>', 'index.css': 'a{}', 'index.js': ';' };

function fake(
  found: CollectionItem[] = [],
  failOn?: string,
  attachments?: Record<string, unknown>[],
  metadata = '<xml/>',
) {
  const calls: string[] = [];
  const state = { created: null as unknown, edited: null as unknown, uploads: [] as string[] };
  const client: IndexClient = {
    async findByField(_c, path, value) {
      calls.push(`find ${path}=${value}`);
      return found;
    },
    async createStagingArea() {
      calls.push('stage');
      return 'stg-1';
    },
    async uploadToStaging(_s, name) {
      if (failOn === 'upload' || failOn === 'cleanup') throw new Error('network down');
      state.uploads.push(name);
    },
    async deleteStagingArea(s) {
      calls.push(`delete ${s}`);
      if (failOn === 'cleanup') throw new Error('cleanup failed');
    },
    async createItem(req) {
      state.created = req;
      return { uuid: 'new-1', version: 1, attachmentUuids: [] };
    },
    async getItemBean(uuid, version) {
      return {
        uuid,
        version,
        status: 'live',
        metadata,
        attachments: attachments ?? [
          { type: 'file', filename: 'index.html', uuid: 'keep-html' },
          { type: 'file', filename: 'index.css', uuid: 'keep-css' },
          { type: 'url', url: 'https://example.org', uuid: 'keep-url' },
        ],
      };
    },
    async editItem(uuid, version, bean, staging) {
      state.edited = { uuid, version, bean, staging };
    },
  };
  return { client, calls, state };
}
const hit = (uuid: string, status = 'live'): CollectionItem => ({ uuid, version: 2, status, name: uuid, attachments: [] });

describe('findExistingIndex', () => {
  it('none, one or many', async () => {
    expect(await findExistingIndex(fake().client, 'c1', record)).toEqual({ kind: 'none' });
    expect(await findExistingIndex(fake([hit('a', 'draft')]).client, 'c1', record)).toEqual({
      kind: 'one',
      uuid: 'a',
      version: 2,
      status: 'draft',
    });
    expect(await findExistingIndex(fake([hit('a'), hit('b')]).client, 'c1', record)).toEqual({
      kind: 'many',
      items: [
        { uuid: 'a', name: 'a' },
        { uuid: 'b', name: 'b' },
      ],
    });
  });

  it('is unavailable, without searching, when the record has no identifier', async () => {
    const f = fake();
    const r = await findExistingIndex(f.client, 'c1', { ...record, identifier: null, identifierProblem: 'no field' });
    expect(r).toEqual({ kind: 'unavailable', reason: 'no field' });
    expect(f.calls).toEqual([]);
  });
});

describe('publishIndex', () => {
  it('creates a new item with the three files and the draft flag', async () => {
    const f = fake();
    const r = await publishIndex(f.client, { collectionUuid: 'c1', record, files, existing: { kind: 'none' }, draft: true });
    expect(r).toEqual({ kind: 'created', uuid: 'new-1', version: 1 });
    expect(f.state.uploads).toEqual(['index.html', 'index.css', 'index.js']);
    expect(f.state.created).toMatchObject({
      collectionUuid: 'c1',
      stagingUuid: 'stg-1',
      draft: true,
      attachments: [
        { filename: 'index.html', description: 'index.html' },
        { filename: 'index.css', description: 'index.css' },
        { filename: 'index.js', description: 'index.js' },
      ],
    });
  });

  it('updates the one existing item in place, keeping attachment uuids and anything else attached', async () => {
    const f = fake();
    const r = await publishIndex(f.client, {
      collectionUuid: 'c1',
      record,
      files,
      existing: { kind: 'one', uuid: 'a', version: 2, status: 'live' },
      draft: true, // ignored: an update keeps the item's state
    });
    expect(r).toEqual({ kind: 'updated', uuid: 'a', version: 2 });
    const edited = f.state.edited as { bean: { attachments: { filename?: string; uuid: string }[]; status: string; metadata: string } };
    expect(edited.bean.status).toBe('live');
    expect(edited.bean.metadata).toContain('<identifier>FQ_index</identifier>');
    expect(edited.bean.attachments.find((a) => a.filename === 'index.html')!.uuid).toBe('keep-html');
    expect(edited.bean.attachments.find((a) => a.filename === 'index.css')!.uuid).toBe('keep-css');
    expect(edited.bean.attachments.some((a) => a.uuid === 'keep-url')).toBe(true);
    expect(edited.bean.attachments).toHaveLength(4);
    expect(edited.bean.attachments.find((a) => a.filename === 'index.js')!.uuid).toMatch(/.+/);
  });

  it('an update changes only the fields the template names, keeping the rest of the record', async () => {
    const f = fake([], undefined, undefined, '<xml><DC><title>Old</title><rights>Kept rights</rights></DC></xml>');
    await publishIndex(f.client, {
      collectionUuid: 'c1',
      record,
      files,
      existing: { kind: 'one', uuid: 'a', version: 2, status: 'live' },
      draft: true,
    });
    const metadata = (f.state.edited as { bean: { metadata: string } }).bean.metadata;
    expect(metadata).toBe(
      '<xml><DC><title>Fernbrook index</title><rights>Kept rights</rights><identifier>FQ_index</identifier></DC></xml>',
    );
  });

  it('refuses several matches or no identifier, and stages nothing', async () => {
    const f = fake();
    await expect(
      publishIndex(f.client, {
        collectionUuid: 'c1',
        record,
        files,
        existing: { kind: 'many', items: [{ uuid: 'a', name: 'A' }, { uuid: 'b', name: 'B' }] },
        draft: true,
      }),
    ).rejects.toThrow(/A, B/);
    await expect(
      publishIndex(f.client, { collectionUuid: 'c1', record, files, existing: { kind: 'unavailable', reason: 'no field' }, draft: true }),
    ).rejects.toThrow(/no field/);
    expect(f.calls).toEqual([]);
  });

  it('deletes the staging area when anything fails', async () => {
    const f = fake([], 'upload');
    await expect(
      publishIndex(f.client, { collectionUuid: 'c1', record, files, existing: { kind: 'none' }, draft: true }),
    ).rejects.toThrow(/network down/);
    expect(f.calls).toContain('delete stg-1');
  });

  it('creates with draft false when asked to publish', async () => {
    const f = fake();
    await publishIndex(f.client, { collectionUuid: 'c1', record, files, existing: { kind: 'none' }, draft: false });
    expect(f.state.created).toMatchObject({ draft: false });
  });

  it('gives new uuids to the index files when the item has none, keeping other attachments after them', async () => {
    const f = fake([], undefined, [{ type: 'file', filename: 'report.pdf', uuid: 'keep-pdf' }]);
    await publishIndex(f.client, {
      collectionUuid: 'c1',
      record,
      files,
      existing: { kind: 'one', uuid: 'a', version: 2, status: 'live' },
      draft: true,
    });
    const atts = (f.state.edited as { bean: { attachments: { filename?: string; uuid: string }[] } }).bean.attachments;
    expect(atts.map((a) => a.filename)).toEqual(['index.html', 'index.css', 'index.js', 'report.pdf']);
    const fresh = atts.slice(0, 3).map((a) => a.uuid);
    expect(fresh.every((u) => typeof u === 'string' && u.length > 0)).toBe(true);
    expect(new Set(fresh).size).toBe(3);
    expect(atts[3]!.uuid).toBe('keep-pdf');
  });

  it('reports the real failure even when cleanup also fails', async () => {
    const f = fake([], 'cleanup');
    await expect(
      publishIndex(f.client, { collectionUuid: 'c1', record, files, existing: { kind: 'none' }, draft: true }),
    ).rejects.toThrow(/network down/);
  });
});
