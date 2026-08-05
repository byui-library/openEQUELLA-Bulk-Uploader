import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveManifest, loadManifest } from '../src/core/state.js';
import type { Manifest } from '../src/core/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-'));
});

const manifest = (): Manifest => ({
  version: 1,
  createdAt: '2026-08-03T00:00:00.000Z',
  baseUrl: 'https://example.test',
  collectionUuid: 'c-uuid',
  schemaUuid: 's-uuid',
  itemState: 'draft',
  attachmentColumn: 'attachment name',
  entries: [
    {
      rowNumber: 2,
      filePath: '/tmp/a.mp4',
      fileName: 'a.mp4',
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
      filePath: '/tmp/b.mp4',
      fileName: 'b.mp4',
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
