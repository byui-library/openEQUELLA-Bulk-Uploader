import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { buildManifest, preflightDuplicates, markSkipped } from '../src/core/plan.js';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { ValidationError } from '../src/core/errors.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';
import type { Sheet, Manifest } from '../src/core/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-plan-'));
  await writeFile(join(dir, 'a.mp4'), 'aaa');
  await writeFile(join(dir, 'b.mp4'), 'bbb');
});

const paths = new Set(['MWDL/title', 'MWDL/identifier', 'Local/attachments/attachment']);

const sheet = (rows: Record<string, string>[]): Sheet => ({
  headers: ['attachment name', 'MWDL/title', 'MWDL/identifier', 'Local/attachments/attachment'],
  rows: rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
});

const opts = {
  baseUrl: 'https://example.test',
  collectionUuid: 'c1',
  schemaUuid: 's1',
  itemState: 'draft' as const,
  // An incoming spreadsheet puts the FILENAME in this column; the runner
  // substitutes the real uuid, so plan-time must not carry the cell through.
  attachmentUuidPath: 'Local/attachments/attachment',
};

describe('buildManifest', () => {
  it('matches rows to files and carries metadata through', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a.mp4', 'Local/attachments/attachment': 'a.mp4' }]),
      dir, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]!.fileName).toBe('a.mp4');
    expect(m.entries[0]!.metadata['MWDL/title']).toEqual(['A']);
  });

  it('strips the attachment-uuid xpath, which is filled in after upload', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a.mp4', 'Local/attachments/attachment': 'a.mp4' }]),
      dir, paths, opts,
    );
    expect(m.entries[0]!.metadata['Local/attachments/attachment']).toBeUndefined();
  });

  /**
   * With no path configured the runner writes no such field, so there is
   * nothing for plan to reserve: the header is an ordinary column like any
   * other, and the skip is a no-op rather than a hidden rule that silently
   * drops one of the operator's columns.
   */
  it('reserves nothing when no attachment-uuid path is configured', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a.mp4', 'Local/attachments/attachment': 'a.mp4' }]),
      dir, paths, { ...opts, attachmentUuidPath: '' },
    );
    expect(m.entries[0]!.metadata['Local/attachments/attachment']).toEqual(['a.mp4']);
    expect(m.attachmentUuidPath).toBe('');
  });

  /** The runner reads it from the manifest, not from the environment it happens
   *  to run in -- a batch planned today must run the same way tomorrow. */
  it('records the configured attachment-uuid path in the manifest', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a.mp4', 'Local/attachments/attachment': 'a.mp4' }]),
      dir, paths, opts,
    );
    expect(m.attachmentUuidPath).toBe('Local/attachments/attachment');
  });

  it('excludes a row whose file is missing and records why', async () => {
    const m = await buildManifest(
      sheet([
        { 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'Local/attachments/attachment': '' },
        { 'attachment name': 'ghost.mp4', 'MWDL/title': 'G', 'MWDL/identifier': 'g', 'Local/attachments/attachment': '' },
      ]),
      dir, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(m.warnings.join(' ')).toMatch(/ghost\.mp4/);
  });

  it('warns about a file with no row but does not fail', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'Local/attachments/attachment': '' }]),
      dir, paths, opts,
    );
    expect(m.warnings.join(' ')).toMatch(/b\.mp4/);
  });

  it('rejects an unknown header before any file work', async () => {
    const bad: Sheet = { headers: ['attachment name', 'MWDL/Title'], rows: [] };
    await expect(buildManifest(bad, dir, paths, opts)).rejects.toThrow(/MWDL\/Title/);
  });

  it('matches filenames case-insensitively, since .MP4 and .mp4 both occur', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'A.MP4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'Local/attachments/attachment': '' }]),
      dir, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]!.fileName).toBe('a.mp4');
  });

  it('produces an absolute filePath even when filesDir is given relative to cwd', async () => {
    const rel = relative(process.cwd(), dir);
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'Local/attachments/attachment': '' }]),
      rel, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(isAbsolute(m.entries[0]!.filePath)).toBe(true);
  });

  it('hard-fails when two rows claim the same file, since each file may back only one contribution', async () => {
    await expect(
      buildManifest(
        sheet([
          { 'attachment name': 'a.mp4', 'MWDL/title': 'A1', 'MWDL/identifier': 'a1', 'Local/attachments/attachment': '' },
          { 'attachment name': 'A.MP4', 'MWDL/title': 'A2', 'MWDL/identifier': 'a2', 'Local/attachments/attachment': '' },
        ]),
        dir, paths, opts,
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('reports both conflicting row numbers when two rows claim the same file', async () => {
    const err = await buildManifest(
      sheet([
        { 'attachment name': 'a.mp4', 'MWDL/title': 'A1', 'MWDL/identifier': 'a1', 'Local/attachments/attachment': '' },
        { 'attachment name': 'a.mp4', 'MWDL/title': 'A2', 'MWDL/identifier': 'a2', 'Local/attachments/attachment': '' },
      ]),
      dir, paths, opts,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/row/i);
    expect((err as Error).message).toMatch(/2/);
    expect((err as Error).message).toMatch(/3/);
  });

  it('ignores a subdirectory of filesDir rather than treating it as a candidate file', async () => {
    await mkdir(join(dir, 'subdir'));
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'Local/attachments/attachment': '' }]),
      dir, paths, opts,
    );
    // The subdirectory must not show up as an unmatched "file" warning, and
    // must not have been matchable as a row's attachment either.
    expect(m.warnings.join(' ')).not.toMatch(/subdir/);
  });

  it('throws loudly on an empty batch instead of silently planning zero uploads', async () => {
    // Neither a.mp4 nor b.mp4 is claimed by any row -- almost certainly a
    // wrong directory or a wrong 'attachment name' column, not a real batch.
    await expect(
      buildManifest(sheet([]), dir, paths, opts),
    ).rejects.toThrow(ValidationError);
  });
});

describe('preflightDuplicates', () => {
  let mock: MockServer;
  let client: OeqClient;

  beforeEach(async () => {
    mock = await startMockServer();
    client = new OeqClient(mock.url, new OAuthClientCredentials(mock.url, 'good-id', 'secret'));
  });
  afterEach(async () => {
    await mock.close();
  });

  const manifestWith = (identifier: string | undefined): Manifest => ({
    version: 1,
    createdAt: new Date().toISOString(),
    baseUrl: mock.url,
    collectionUuid: 'c1',
    schemaUuid: 's1',
    itemState: 'draft',
    attachmentColumn: 'attachment name',
    entries: [
      {
        rowNumber: 2,
        filePath: join(dir, 'a.mp4'),
        fileName: 'a.mp4',
        metadata: identifier === undefined ? {} : { 'MWDL/identifier': [identifier] },
        status: 'pending',
        attempts: 0,
      },
    ],
    warnings: [],
  });

  it('warns when an identifier already exists in the collection', async () => {
    mock.state.existingIdentifiers = ['a.mp4'];
    const warnings = await preflightDuplicates(client, manifestWith('a.mp4'));
    expect(warnings.join(' ')).toMatch(/a\.mp4/);
  });

  it('produces no warning when the identifier does not already exist', async () => {
    const warnings = await preflightDuplicates(client, manifestWith('a.mp4'));
    expect(warnings).toHaveLength(0);
  });

  it('skips entries with no identifier silently', async () => {
    const warnings = await preflightDuplicates(client, manifestWith(undefined));
    expect(warnings).toHaveLength(0);
  });

  it('never modifies the manifest -- a duplicate is advisory only', async () => {
    mock.state.existingIdentifiers = ['a.mp4'];
    const manifest = manifestWith('a.mp4');
    const before = JSON.stringify(manifest);
    await preflightDuplicates(client, manifest);
    expect(JSON.stringify(manifest)).toBe(before);
  });

  it('survives a network failure without throwing, and warns the check could not complete', async () => {
    const manifest = manifestWith('a.mp4');
    await mock.close();
    const warnings = await preflightDuplicates(client, manifest);
    expect(warnings.join(' ')).toMatch(/could not|fail|error/i);
  });
});

describe('markSkipped', () => {
  function twoRowManifest(): Manifest {
    return {
      version: 1,
      createdAt: '2026-08-06T00:00:00.000Z',
      baseUrl: 'https://example.test',
      collectionUuid: 'c1',
      schemaUuid: 's1',
      itemState: 'draft',
      attachmentColumn: 'attachment name',
      warnings: [],
      entries: [2, 3].map((rowNumber) => ({
        rowNumber,
        filePath: `/f/${rowNumber}.pdf`,
        fileName: `${rowNumber}.pdf`,
        metadata: {},
        status: 'pending' as const,
        attempts: 0,
      })),
    };
  }

  it('marks only the named rows', () => {
    const m = twoRowManifest();
    markSkipped(m, [2], 'a duplicate');
    expect(m.entries[0]?.status).toBe('skipped');
    expect(m.entries[1]?.status).toBe('pending');
  });

  it('records why, so Results is not a mystery', () => {
    const m = twoRowManifest();
    markSkipped(m, [2], 'skipped as a duplicate of an existing item');
    expect(m.entries[0]?.error).toBe('skipped as a duplicate of an existing item');
  });

  it('returns how many it marked', () => {
    expect(markSkipped(twoRowManifest(), [2, 3], 'x')).toBe(2);
  });

  it('ignores a row number that is not in the manifest', () => {
    expect(markSkipped(twoRowManifest(), [99], 'x')).toBe(0);
  });

  // A row already created must not be rewritten to skipped: that would lose
  // the record that an item exists for it.
  it('never touches a row that is not pending', () => {
    const m = twoRowManifest();
    m.entries[0]!.status = 'created';
    expect(markSkipped(m, [2], 'x')).toBe(0);
    expect(m.entries[0]?.status).toBe('created');
  });
});
