import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runManifest, checkLock } from '../src/core/runner.js';
import { acquireLock, releaseLock } from '../src/core/lock.js';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { loadManifest, saveManifest } from '../src/core/state.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';
import type { Manifest } from '../src/core/types.js';

let mock: MockServer;
let client: OeqClient;
let dir: string;

beforeEach(async () => {
  mock = await startMockServer();
  client = new OeqClient(mock.url, new OAuthClientCredentials(mock.url, 'good-id', 'secret'));
  dir = await mkdtemp(join(tmpdir(), 'oeq-run-'));
  await writeFile(join(dir, 'a.mp4'), Buffer.alloc(32));
  await writeFile(join(dir, 'b.mp4'), Buffer.alloc(32));
});
afterEach(async () => {
  await mock.close();
});

const manifest = (): Manifest => ({
  version: 1,
  createdAt: '2026-08-03T00:00:00.000Z',
  baseUrl: mock.url,
  collectionUuid: 'c1',
  schemaUuid: 's1',
  itemState: 'draft',
  attachmentColumn: 'attachment name',
  warnings: [],
  entries: ['a.mp4', 'b.mp4'].map((f, i) => ({
    rowNumber: i + 2,
    filePath: join(dir, f),
    fileName: f,
    metadata: { 'MWDL/title': [f] },
    status: 'pending' as const,
    attempts: 0,
  })),
});

describe('runManifest', () => {
  it('creates one item per entry and records the uuids', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(2);
    const done = await loadManifest(path);
    expect(done.entries.every((e) => e.status === 'created')).toBe(true);
    expect(done.entries[0]!.itemUuid).toMatch(/^item-/);
  });

  it('writes the attachment uuid into the metadata it sends', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    await runManifest(client, path, { retryDelayMs: 1 });
    expect(mock.state.items[0]!.metadata).toMatch(
      /<BYUI_extended><attachments><attachment>[^<]+<\/attachment>/,
    );
  });

  it('skips entries already created, so re-running is safe', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.status = 'created';
    m.entries[0]!.itemUuid = 'item-existing';
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(mock.state.items).toHaveLength(1);
  });

  it('retries a 503 and then succeeds', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    mock.state.failItemNext = 1;
    const summary = await runManifest(client, path, { retryDelayMs: 1, maxAttempts: 3 });
    expect(summary.created).toBe(2);
  });

  it('isolates a permanent failure without stopping the batch', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.filePath = join(dir, 'does-not-exist.mp4');
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(1);
    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('failed');
    expect(done.entries[0]!.error).toBeTruthy();
  });

  it('identifies the row and file in a failure message', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.filePath = join(dir, 'does-not-exist.mp4');
    await saveManifest(path, m);
    await runManifest(client, path, { retryDelayMs: 1 });
    const done = await loadManifest(path);
    // rowNumber for entries[0] is 2 (i + 2 with i=0), fileName is 'a.mp4'.
    expect(done.entries[0]!.error).toMatch(/^Row 2 \(a\.mp4\):/);
  });

  it('reports an ApiError failure with row context prefixed onto the original message', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    // Exhaust every attempt with a retryable failure so the row ends up
    // genuinely failed (not just retried-then-succeeded).
    mock.state.failItemNext = 99;
    const summary = await runManifest(client, path, { retryDelayMs: 1, maxAttempts: 2 });
    expect(summary.failed).toBe(2);
    const done = await loadManifest(path);
    expect(done.entries[0]!.error).toMatch(/^Row 2 \(a\.mp4\): POST \/api\/item/);
  });

  it('still attempts an entry whose cumulative attempts count already exceeds maxAttempts', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.attempts = 5; // cumulative from earlier resumed runs
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1, maxAttempts: 3 });
    expect(summary.created).toBe(2);
    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('created');
    // The per-invocation loop still ran (at least once more), so the
    // cumulative counter grew past its pre-existing value.
    expect(done.entries[0]!.attempts).toBeGreaterThan(5);
  });

  it('marks an entry incomplete, not created, when the server assigns a different attachment uuid', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    mock.state.mismatchAttachmentNext = 1;
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(1);
    expect(summary.incomplete).toBe(1);
    expect(summary.failed).toBe(0);
    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('incomplete');
    expect(done.entries[0]!.status).not.toBe('created');
    expect(done.entries[0]!.error).toBeTruthy();
    expect(done.entries[0]!.itemUuid).toMatch(/^item-/);
    expect(done.entries[1]!.status).toBe('created');
  });

  it('does not reprocess an incomplete entry on a later run (would duplicate the item)', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.status = 'incomplete';
    m.entries[0]!.itemUuid = 'item-existing';
    m.entries[0]!.error = 'pre-existing mismatch';
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(1);
    expect(mock.state.items).toHaveLength(1);
    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('incomplete');
    expect(done.entries[0]!.error).toBe('pre-existing mismatch');
  });

  it('never lets a throwing onProgress callback abort the batch', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    const summary = await runManifest(client, path, {
      retryDelayMs: 1,
      onProgress: () => {
        throw new Error('boom: bad CLI formatting code');
      },
    });
    expect(summary.created).toBe(2);
  });
});

describe('runManifest job lock', () => {
  it('throws a clear error naming the owning pid when another live run holds the lock', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    await acquireLock(path);
    try {
      await expect(runManifest(client, path, { retryDelayMs: 1 })).rejects.toThrow(
        new RegExp(String(process.pid)),
      );
      // The run must never have started: nothing was created.
      expect(mock.state.items).toHaveLength(0);
    } finally {
      await releaseLock(path);
    }
  });

  it('removes the lock after a run completes successfully', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    expect(await checkLock(path)).toBeNull();
    await runManifest(client, path, { retryDelayMs: 1 });
    expect(await checkLock(path)).toBeNull();
  });

  it('removes the lock even when the run throws before completing', async () => {
    const path = join(dir, 'job.json');
    // Not valid JSON: loadManifest() (called after the lock is acquired)
    // will throw, exercising the error path of the lock's try/finally.
    await writeFile(path, 'not valid json', 'utf8');
    await expect(runManifest(client, path, { retryDelayMs: 1 })).rejects.toThrow();
    expect(await checkLock(path)).toBeNull();
  });

  it('reclaims a stale lock left by a process that is no longer running', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    // A pid this large cannot correspond to a real running process.
    await writeFile(
      `${path}.lock`,
      JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }),
      'utf8',
    );
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(2);
    expect(await checkLock(path)).toBeNull();
  });
});
