import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planAction, runAction, statusAction, retryAction } from '../src/cli/index.js';
import { acquireLock, releaseLock } from '../src/core/lock.js';
import { saveManifest, loadManifest } from '../src/core/state.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';
import type { Manifest } from '../src/core/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-cli-'));
});

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  version: 1,
  createdAt: '2026-08-03T00:00:00.000Z',
  baseUrl: 'https://example.test',
  collectionUuid: 'c1',
  schemaUuid: 's1',
  itemState: 'draft',
  attachmentColumn: 'attachment name',
  warnings: [],
  entries: [],
  ...overrides,
});

describe('planAction --state validation', () => {
  it('rejects a bogus --state before touching the filesystem or environment', async () => {
    await expect(
      planAction(
        {
          sheet: 'does-not-exist.csv',
          files: 'does-not-exist-dir',
          manifest: join(dir, 'job.json'),
          schemaFile: 'does-not-exist.xml',
          state: 'bogus',
        },
        {},
      ),
    ).rejects.toThrow(/--state must be 'draft' or 'published'/);
  });

  it('accepts draft and published', async () => {
    // Neither reaches loadConfig with a bogus state, so this only proves
    // valid values pass the guard -- config/file errors surface afterward.
    await expect(
      planAction(
        {
          sheet: 'x',
          files: 'y',
          manifest: 'z',
          schemaFile: 'w',
          state: 'draft',
        },
        {},
      ),
    ).rejects.not.toThrow(/--state must be/);
  });
});

describe('retryAction and a live lock', () => {
  it('refuses to run, and does not write, while a live lock is held', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: {},
          status: 'failed',
          attempts: 3,
          error: 'boom',
        },
      ],
    });
    await saveManifest(path, m);
    // acquireLock() records the current process's own pid, which is always
    // alive -- the definitionally-live lock the task calls for.
    await acquireLock(path);
    try {
      await expect(retryAction({ manifest: path })).rejects.toThrow(new RegExp(String(process.pid)));
      const stillLocked = await loadManifest(path);
      expect(stillLocked.entries[0]!.status).toBe('failed');
      expect(stillLocked.entries[0]!.attempts).toBe(3);
    } finally {
      await releaseLock(path);
    }
  });

  it('resets failed entries to pending (and attempts to 0) when no lock is held', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: {},
          status: 'failed',
          attempts: 3,
          error: 'boom',
        },
        {
          rowNumber: 3,
          filePath: join(dir, 'b.mp4'),
          fileName: 'b.mp4',
          metadata: {},
          status: 'created',
          attempts: 1,
          itemUuid: 'item-1',
        },
      ],
    });
    await saveManifest(path, m);

    await retryAction({ manifest: path });

    const after = await loadManifest(path);
    expect(after.entries[0]!.status).toBe('pending');
    expect(after.entries[0]!.attempts).toBe(0);
    expect(after.entries[0]!.error).toBeUndefined();
    // A row that already succeeded must never be touched by retry.
    expect(after.entries[1]!.status).toBe('created');
    expect(after.entries[1]!.attempts).toBe(1);
  });

  it('does not reset entries left "uploading" (interrupted-at-load) -- that needs --force-interrupted on run', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: {},
          status: 'uploading',
          attempts: 1,
          error: 'a previous run was interrupted while processing this row.',
        },
      ],
    });
    await saveManifest(path, m);

    await retryAction({ manifest: path });

    const after = await loadManifest(path);
    expect(after.entries[0]!.status).toBe('uploading');
  });
});

describe('statusAction', () => {
  it('reports counts and the lock holder', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: {},
          status: 'failed',
          attempts: 1,
          error: 'boom',
        },
      ],
    });
    await saveManifest(path, m);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await statusAction({ manifest: path });
    } finally {
      console.log = orig;
    }
    expect(logs.join('\n')).toContain('"failed": 1');
    expect(logs.join('\n')).toContain('No active lock.');
  });
});

describe('runAction exit code', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer();
  });
  afterEach(async () => {
    await mock.close();
  });

  const env = () => ({
    OEQ_BASE_URL: mock.url,
    OEQ_CLIENT_ID: 'good-id',
    OEQ_CLIENT_SECRET: 'secret',
  });

  it('returns 0 when nothing failed, even if rows were interrupted', async () => {
    const path = join(dir, 'job.json');
    await writeFile(join(dir, 'a.mp4'), Buffer.alloc(8));
    const m = manifest({
      baseUrl: mock.url,
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'a.mp4'),
          fileName: 'a.mp4',
          metadata: { 'MWDL/title': ['a'] },
          status: 'uploading',
          attempts: 1,
        },
      ],
    });
    await saveManifest(path, m);

    const code = await runAction({ manifest: path }, env());
    expect(code).toBe(0);
    const after = await loadManifest(path);
    expect(after.entries[0]!.status).toBe('uploading');
  });

  it('returns 1 when any row genuinely failed', async () => {
    const path = join(dir, 'job.json');
    const m = manifest({
      baseUrl: mock.url,
      entries: [
        {
          rowNumber: 2,
          filePath: join(dir, 'does-not-exist.mp4'),
          fileName: 'does-not-exist.mp4',
          metadata: { 'MWDL/title': ['a'] },
          status: 'pending',
          attempts: 0,
        },
      ],
    });
    await saveManifest(path, m);

    const code = await runAction({ manifest: path, maxAttempts: 1 }, env());
    expect(code).toBe(1);
  });
});
