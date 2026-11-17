import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveManifest, loadManifest } from '../src/core/state.js';
import { rowLabel, type Manifest } from '../src/core/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-'));
});

const manifest = (): Manifest => ({
  version: 2,
  createdAt: '2026-08-03T00:00:00.000Z',
  baseUrl: 'https://example.test',
  collectionUuid: 'c-uuid',
  schemaUuid: 's-uuid',
  itemState: 'draft',
  attachmentColumn: 'attachment name',
  entries: [
    {
      rowNumber: 2,
      source: 'a.mp4',
      files: [{ path: '/tmp/a.mp4', name: 'a.mp4' }],
      metadata: { 'MWDL/title': ['A'] },
      status: 'pending',
      attempts: 0,
    },
  ],
  warnings: [],
});

describe('state', () => {
  it('round-trips a manifest', async () => {
    const p = join(dir, 'job.json');
    await saveManifest(p, manifest());
    const loaded = await loadManifest(p);
    expect(loaded.entries[0]!.metadata['MWDL/title']).toEqual(['A']);
    expect(loaded.itemState).toBe('draft');
  });

  it('leaves no temp file behind', async () => {
    const p = join(dir, 'job.json');
    await saveManifest(p, manifest());
    await expect(readFile(`${p}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('rejects a manifest with an unknown version', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, JSON.stringify({ version: 99 }), 'utf8');
    await expect(loadManifest(p)).rejects.toThrow(/version/i);
  });

  it('gives each save a unique temp name so concurrent saves cannot interleave', async () => {
    const p = join(dir, 'job.json');
    const m = manifest();
    const other: Manifest = { ...m, collectionUuid: 'different-uuid' };

    await Promise.all([saveManifest(p, m), saveManifest(p, other)]);

    // Both writes must have completed cleanly: the final file is valid JSON
    // and parses as a well-formed manifest (whichever write "won" the rename).
    const loaded = await loadManifest(p);
    expect(['c-uuid', 'different-uuid']).toContain(loaded.collectionUuid);

    // No leftover .tmp.* files from either concurrent writer.
    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('gives a helpful error for a missing manifest file', async () => {
    const p = join(dir, 'does-not-exist.json');
    await expect(loadManifest(p)).rejects.toThrow(/does-not-exist\.json/);
  });

  it('gives a helpful error for malformed JSON', async () => {
    const p = join(dir, 'malformed.json');
    await writeFile(p, '{ this is not valid json', 'utf8');
    await expect(loadManifest(p)).rejects.toThrow(/malformed\.json/);
  });

  it('rejects a structurally invalid manifest (entries not an array)', async () => {
    const p = join(dir, 'bad-structure.json');
    const bad = { ...manifest(), entries: 'oops' };
    await writeFile(p, JSON.stringify(bad), 'utf8');
    await expect(loadManifest(p)).rejects.toThrow(/entries/i);
  });

  it('rejects a manifest missing a collectionUuid', async () => {
    const p = join(dir, 'no-collection.json');
    const bad = { ...manifest(), collectionUuid: '' };
    await writeFile(p, JSON.stringify(bad), 'utf8');
    await expect(loadManifest(p)).rejects.toThrow(/collectionUuid/i);
  });

  it('rejects a manifest with an invalid itemState', async () => {
    const p = join(dir, 'bad-item-state.json');
    const bad = { ...manifest(), itemState: 'in-progress' };
    await writeFile(p, JSON.stringify(bad), 'utf8');
    await expect(loadManifest(p)).rejects.toThrow(/itemState/i);
  });

  it('round-trips a failed entry carrying an error string', async () => {
    const p = join(dir, 'failed-entry.json');
    const m = manifest();
    m.entries.push({
      rowNumber: 3,
      source: 'b.mp4',
      files: [{ path: '/tmp/b.mp4', name: 'b.mp4' }],
      metadata: { 'MWDL/title': ['B'] },
      status: 'failed',
      error: 'network timeout uploading attachment',
      attempts: 2,
    });
    await saveManifest(p, m);
    const loaded = await loadManifest(p);
    const failed = loaded.entries.find((e) => e.status === 'failed');
    expect(failed?.error).toBe('network timeout uploading attachment');
    expect(failed?.attempts).toBe(2);
  });
});

describe('manifest v1 compatibility', () => {
  const v1 = (entry: Record<string, unknown>) =>
    JSON.stringify({
      version: 1,
      createdAt: 'x',
      baseUrl: 'https://h',
      collectionUuid: 'c',
      schemaUuid: 's',
      itemState: 'draft',
      attachmentColumn: 'attachment name',
      warnings: [],
      entries: [entry],
    });

  it('loads a v1 manifest as v2: one-element files list, no size, uuid as a list', async () => {
    const path = join(dir, 'v1.json');
    await writeFile(
      path,
      v1({
        rowNumber: 2,
        filePath: '/b/clip.mp4',
        fileName: 'clip.mp4',
        metadata: {},
        status: 'created',
        itemUuid: 'i',
        itemVersion: 1,
        attachmentUuid: 'a1',
        attempts: 1,
      }),
    );
    const m = await loadManifest(path);
    expect(m.version).toBe(2);
    expect(m.entries[0]).toEqual({
      rowNumber: 2,
      source: 'clip.mp4',
      files: [{ path: '/b/clip.mp4', name: 'clip.mp4' }],
      metadata: {},
      status: 'created',
      itemUuid: 'i',
      itemVersion: 1,
      attachmentUuids: ['a1'],
      attempts: 1,
    });
  });

  it('a v1 row with no attachment uuid gets no attachmentUuids key', async () => {
    const path = join(dir, 'v1b.json');
    await writeFile(
      path,
      v1({ rowNumber: 2, filePath: '/b/a.pdf', fileName: 'a.pdf', metadata: {}, status: 'pending', attempts: 0 }),
    );
    expect('attachmentUuids' in (await loadManifest(path)).entries[0]!).toBe(false);
  });

  it('a v1 manifest is saved back as v2', async () => {
    const path = join(dir, 'v1c.json');
    await writeFile(
      path,
      v1({ rowNumber: 2, filePath: '/b/a.pdf', fileName: 'a.pdf', metadata: {}, status: 'pending', attempts: 0 }),
    );
    await saveManifest(path, await loadManifest(path));
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.entries[0].fileName).toBeUndefined();
  });
});

describe('rowLabel', () => {
  it('is the filename for a file row', () => {
    expect(rowLabel({ source: 'a.pdf', files: [{ path: '/a.pdf', name: 'a.pdf' }] })).toBe('a.pdf');
  });
  it('counts files for a folder row, singular included', () => {
    const f = { path: '/v/x', name: 'x' };
    expect(rowLabel({ source: 'Vol2', folderPath: '/v', files: [f, f, f] })).toBe('Vol2 (3 files)');
    expect(rowLabel({ source: 'Vol9', folderPath: '/v', files: [f] })).toBe('Vol9 (1 file)');
  });
});
