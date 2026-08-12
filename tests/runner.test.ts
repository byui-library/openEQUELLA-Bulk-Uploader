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
import { buildMetadataXml } from '../src/core/metadata.js';
import type { Manifest } from '../src/core/types.js';

/** A configured attachment-uuid path. Deliberately not any real institution's. */
const ATTACHMENT_PATH = 'Local/attachments/attachment';

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
    // A normal run transitions every entry through 'uploading' in memory on
    // its way to 'created'. That must never be mistaken for the interrupted
    // -at-load case below -- the scan for leftover 'uploading' entries runs
    // once, before this loop starts, not on every iteration.
    expect(summary.interrupted).toBe(0);
    const done = await loadManifest(path);
    expect(done.entries.every((e) => e.status === 'created')).toBe(true);
    expect(done.entries[0]!.itemUuid).toMatch(/^item-/);
  });

  it('writes the attachment uuid into the metadata it sends when a path is configured', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.attachmentUuidPath = ATTACHMENT_PATH;
    await saveManifest(path, m);
    await runManifest(client, path, { retryDelayMs: 1 });
    expect(mock.state.items[0]!.metadata).toMatch(
      /<Local><attachments><attachment>[^<]+<\/attachment>/,
    );
  });

  /**
   * The field is a convenience index that one institution's schema declares.
   * Writing it anywhere else means writing to a node the collection's schema
   * does not have -- junk at best, a failed create at worst, and neither is
   * diagnosable from the resulting message. The attachment itself is linked
   * through the attachment API and is unaffected either way.
   *
   * Asserted against the WHOLE metadata document, not just the absence of one
   * key: a fallback path (the old hardcoded constant, say) would still satisfy
   * "the configured path is absent".
   */
  it('writes no attachment-uuid field at all when no path is configured', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    await runManifest(client, path, { retryDelayMs: 1 });
    const sent = mock.state.items[0]!.metadata;
    expect(sent).toBe(buildMetadataXml({ 'MWDL/title': ['a.mp4'] }));
    expect(sent).not.toMatch(/attachment/i);
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
    const m = manifest();
    // The row is incomplete because the metadata ALREADY SENT names the uuid
    // we asked for. That is only true when the field was written at all.
    m.attachmentUuidPath = ATTACHMENT_PATH;
    await saveManifest(path, m);
    mock.state.mismatchAttachmentNext = 1;
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(1);
    expect(summary.incomplete).toBe(1);
    expect(summary.failed).toBe(0);
    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('incomplete');
    expect(done.entries[0]!.status).not.toBe('created');
    expect(done.entries[0]!.error).toBeTruthy();
    // The message must still name the field that is now stale, so the operator
    // knows what to correct by hand.
    expect(done.entries[0]!.error).toContain(ATTACHMENT_PATH);
    expect(done.entries[0]!.itemUuid).toMatch(/^item-/);
    expect(done.entries[1]!.status).toBe('created');
  });

  /**
   * With no path configured, nothing in the item's metadata references the
   * uuid this tool asked for, so a server-assigned one leaves nothing stale.
   * The item and its attachment are both correct. Reporting `incomplete` here
   * would tell the operator to go and hand-correct a row that is not wrong.
   */
  it('records a uuid mismatch as created, not incomplete, when no path is configured', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    mock.state.mismatchAttachmentNext = 1;
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(2);
    expect(summary.incomplete).toBe(0);
    expect(summary.failed).toBe(0);
    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('created');
    expect(done.entries[0]!.error).toBeUndefined();
    // The uuid recorded is the one the server actually assigned, so the
    // manifest still describes what exists.
    expect(done.entries[0]!.attachmentUuid).toBeTruthy();
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

  it('does not reprocess an entry found "uploading" at load time -- an interrupted prior run', async () => {
    // A crash between createItem succeeding and the trailing saveManifest
    // landing leaves an entry stuck at 'uploading' on disk, with the item
    // possibly already created server-side. Reprocessing it blind would
    // upload the file and create the item again -- a silent duplicate in a
    // collection with no moderation queue to catch it. The runner must
    // treat this as ambiguous and refuse to guess.
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.status = 'uploading';
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.interrupted).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.failed).toBe(0);
    // Only entries[1] ('b.mp4') should have produced an item.
    expect(mock.state.items).toHaveLength(1);
    expect(mock.state.items[0]!.metadata).toContain('b.mp4');

    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('uploading');
    expect(done.entries[0]!.error).toMatch(
      /^Row 2 \(a\.mp4\): a previous run was interrupted while processing this row\./,
    );
    expect(done.entries[0]!.error).toMatch(/may or may not have been created/);
    expect(done.entries[0]!.error).toMatch(/force-interrupted/);
    expect(done.entries[1]!.status).toBe('created');
  });

  it('processes an interrupted entry when forceInterrupted is set, as an explicit operator override', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.status = 'uploading';
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1, forceInterrupted: true });
    expect(summary.interrupted).toBe(0);
    expect(summary.created).toBe(2);
    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('created');
    expect(mock.state.items).toHaveLength(2);
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

  it('reclaims a malformed (corrupt) lock file rather than wedging the job', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    await writeFile(`${path}.lock`, '{not valid json!!', 'utf8');
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(2);
    expect(await checkLock(path)).toBeNull();
  });

  it('releases the lock after a run with a mix of created and failed entries', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.filePath = join(dir, 'does-not-exist.mp4');
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(1);
    expect(summary.failed).toBe(1);
    expect(await checkLock(path)).toBeNull();
  });
});
