import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSchemaPaths,
  validateSheetTool,
  planTool,
  startJobTool,
  jobStatusTool,
  retryFailedTool,
} from '../src/mcp/index.js';
import { acquireLock, releaseLock } from '../src/core/lock.js';
import { saveManifest, loadManifest } from '../src/core/state.js';
import type { Manifest } from '../src/core/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-mcp-'));
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

const configEnv = () => ({
  OEQ_BASE_URL: 'https://example.test',
  OEQ_CLIENT_ID: 'test-client-id',
  OEQ_CLIENT_SECRET: 'super-secret-value',
});

function textOf(result: { content: Array<{ type: 'text'; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

describe('oeq_list_schema_paths', () => {
  it('returns matching xpaths from the real schema for a filter', async () => {
    const result = await listSchemaPaths({ filter: 'creator' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('MWDL/creators/creator');
  });

  it('falls back to nearest-match suggestions when nothing contains the filter literally', async () => {
    const result = await listSchemaPaths({ filter: 'MWDL/creator' });
    // Not an exact substring hit against any real xpath as typed, but should
    // still surface the near match via suggest().
    expect(textOf(result)).toContain('MWDL/creators/creator');
  });
});

describe('oeq_validate_sheet', () => {
  it('reports an invalid header with suggestion text', async () => {
    const sheetPath = join(dir, 'batch.csv');
    // 'MWDL/Title' (wrong case) is not a valid xpath -- only 'MWDL/title' is
    // -- so this should come back invalid with that as the suggestion.
    await writeFile(
      sheetPath,
      [
        'attachment name,MWDL/Title,MWDL/identifier',
        'clip.mp4,Example Title,clip-001',
      ].join('\n'),
    );

    const result = await validateSheetTool({ sheet: sheetPath });
    const out = textOf(result);
    expect(out).toContain("INVALID 'MWDL/Title'");
    expect(out).toContain('did you mean');
    expect(out).toContain('MWDL/title');
  });

  it('reports all headers valid for a clean sheet', async () => {
    const result = await validateSheetTool({ sheet: 'tests/fixtures/sample-batch.csv' });
    expect(textOf(result)).toContain('All headers are valid.');
    expect(result.isError).toBeFalsy();
  });
});

describe('oeq_plan and a live lock', () => {
  it('refuses, naming the owning pid, and writes nothing while a live lock is held', async () => {
    const manifestPath = join(dir, 'job.json');
    // acquireLock() records this test process's own pid, which is
    // definitionally alive -- the live lock the task requires we test against.
    await acquireLock(manifestPath);
    try {
      const result = await planTool(
        { sheet: 'tests/fixtures/sample-batch.csv', filesDir: dir, manifestPath },
        configEnv(),
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(String(process.pid));
      // No writes at all: the manifest must not have been created.
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      await releaseLock(manifestPath);
    }
  });

  it('never leaks OEQ_CLIENT_SECRET into its output, even on error', async () => {
    const manifestPath = join(dir, 'job.json');
    const result = await planTool(
      { sheet: 'does-not-exist.csv', filesDir: dir, manifestPath },
      configEnv(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('super-secret-value');
  });

  it('plans a manifest from the sample batch when unlocked', async () => {
    // Real filenames from tests/fixtures/sample-batch.csv's 'attachment name'
    // column -- not invented student data, just the fixture's own values.
    await writeFile(join(dir, 'Aster, Juniper 010125.MP4'), 'a');
    await writeFile(join(dir, 'Birch ,Rowan 010125.MP4'), 'b');
    await writeFile(join(dir, 'Cedar (Thorn), Wren 010225.mp4'), 'c');

    const manifestPath = join(dir, 'job.json');
    const result = await planTool(
      { sheet: 'tests/fixtures/sample-batch.csv', filesDir: dir, manifestPath },
      configEnv(),
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Planned 3 item(s)');

    const saved = await loadManifest(manifestPath);
    expect(saved.entries).toHaveLength(3);
    expect(saved.itemState).toBe('draft');
  });

  it('rejects an invalid itemState before touching the filesystem', async () => {
    const manifestPath = join(dir, 'job.json');
    const result = await planTool(
      {
        sheet: 'tests/fixtures/sample-batch.csv',
        filesDir: dir,
        manifestPath,
        itemState: 'published-live-oops',
      },
      configEnv(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("must be 'draft' or 'published'");
    expect(existsSync(manifestPath)).toBe(false);
  });
});

describe('oeq_retry_failed and a live lock', () => {
  const failedManifest = () =>
    manifest({
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

  it('refuses, naming the owning pid, and writes nothing while a live lock is held', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, failedManifest());
    await acquireLock(manifestPath);
    try {
      const result = await retryFailedTool({ manifestPath });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(String(process.pid));

      const stillLocked = await loadManifest(manifestPath);
      expect(stillLocked.entries[0]!.status).toBe('failed');
      expect(stillLocked.entries[0]!.attempts).toBe(3);
    } finally {
      await releaseLock(manifestPath);
    }
  });

  it('resets failed entries to pending when no lock is held', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, failedManifest());

    const result = await retryFailedTool({ manifestPath });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Reset 1 failed entry');

    const after = await loadManifest(manifestPath);
    expect(after.entries[0]!.status).toBe('pending');
    expect(after.entries[0]!.attempts).toBe(0);
    expect(after.entries[0]!.error).toBeUndefined();
  });
});

describe('oeq_start_job and a live lock', () => {
  it('refuses to spawn a second runner while a live lock is held', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, manifest());
    await acquireLock(manifestPath);
    try {
      const result = await startJobTool({ manifestPath });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(String(process.pid));
    } finally {
      await releaseLock(manifestPath);
    }
  });

  it('fails clearly, without spawning, when the CLI entry point cannot be found', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, manifest());

    const result = await startJobTool(
      { manifestPath },
      { entryPoint: join(dir, 'does-not-exist', 'index.js') },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('npm run build');
  });

  it('spawns the runner detached and returns immediately when unlocked and the entry exists', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, manifest());

    // A minimal stand-in CLI entry point: exits immediately, proving only
    // that startJobTool actually spawns and detaches, not the real runner's
    // behavior (that's covered by cli.test.ts / runner.test.ts).
    const fakeEntry = join(dir, 'fake-cli.js');
    await writeFile(fakeEntry, 'process.exit(0);\n');

    const result = await startJobTool(
      { manifestPath, logPath: join(dir, 'job.log') },
      { entryPoint: fakeEntry },
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/Started runner pid=\d+/);
  });
});

describe('oeq_job_status', () => {
  it('works while locked and names the lock holder', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(
      manifestPath,
      manifest({
        entries: [
          {
            rowNumber: 2,
            filePath: join(dir, 'a.mp4'),
            fileName: 'a.mp4',
            metadata: {},
            status: 'created',
            attempts: 1,
            itemUuid: 'item-1',
          },
          {
            rowNumber: 3,
            filePath: join(dir, 'b.mp4'),
            fileName: 'b.mp4',
            metadata: {},
            status: 'failed',
            attempts: 2,
            error: 'boom',
          },
        ],
      }),
    );
    await acquireLock(manifestPath);
    try {
      const result = await jobStatusTool({ manifestPath });
      expect(result.isError).toBeFalsy();
      const out = textOf(result);
      expect(out).toContain('"created":1');
      expect(out).toContain('"failed":1');
      expect(out).toContain(`Lock held by pid ${process.pid}`);
    } finally {
      await releaseLock(manifestPath);
    }
  });

  it('reports "No active lock." when unlocked', async () => {
    const manifestPath = join(dir, 'job.json');
    await saveManifest(manifestPath, manifest());
    const result = await jobStatusTool({ manifestPath });
    expect(textOf(result)).toContain('No active lock.');
  });
});
