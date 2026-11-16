import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import {
  buildManifest,
  preflightDuplicates,
  markSkipped,
  applyFolderOrders,
  resolveIdentifierPath,
  NO_IDENTIFIER_PATH_WARNING,
  GUEST_SESSION_WARNING,
} from '../src/core/plan.js';
import {
  extractDefinition,
  extractItemNamePath,
  parseSchemaPaths,
} from '../src/core/schema.js';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { ValidationError } from '../src/core/errors.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';
import type { Sheet, Manifest, RowStatus } from '../src/core/types.js';

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
    expect(m.entries[0]!.source).toBe('a.mp4');
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
    expect(m.entries[0]!.source).toBe('a.mp4');
  });

  it('produces an absolute filePath even when filesDir is given relative to cwd', async () => {
    const rel = relative(process.cwd(), dir);
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'Local/attachments/attachment': '' }]),
      rel, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(isAbsolute(m.entries[0]!.files[0]!.path)).toBe(true);
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

  /** BYU-Idaho's shape, hand-built: an `MWDL` section whose name path is `MWDL/title`. */
  const mwdlSchema = { titleHeader: 'MWDL/title', paths };

  const manifestWith = (
    identifier: string | undefined,
    header = 'MWDL/identifier',
  ): Manifest => ({
    version: 2,
    createdAt: new Date().toISOString(),
    baseUrl: mock.url,
    collectionUuid: 'c1',
    schemaUuid: 's1',
    itemState: 'draft',
    attachmentColumn: 'attachment name',
    entries: [
      {
        rowNumber: 2,
        source: 'a.mp4',
        files: [{ path: join(dir, 'a.mp4'), name: 'a.mp4' }],
        metadata: identifier === undefined ? {} : { [header]: [identifier] },
        status: 'pending',
        attempts: 0,
      },
    ],
    warnings: [],
  });

  it('warns when an identifier already exists in the collection', async () => {
    mock.state.existingIdentifiers = ['a.mp4'];
    const warnings = await preflightDuplicates(client, manifestWith('a.mp4'), mwdlSchema);
    expect(warnings.join(' ')).toMatch(/a\.mp4/);
  });

  it('produces no warning when the identifier does not already exist', async () => {
    const warnings = await preflightDuplicates(client, manifestWith('a.mp4'), mwdlSchema);
    expect(warnings).toHaveLength(0);
  });

  it('skips entries with no identifier silently', async () => {
    const warnings = await preflightDuplicates(client, manifestWith(undefined), mwdlSchema);
    expect(warnings).toHaveLength(0);
  });

  /**
   * A blank cell is genuinely not checkable and genuinely expected -- a
   * hand-made spreadsheet routinely leaves the identifier off some rows. The
   * schema DOES declare the field, so the check ran and found nothing to ask
   * about. That must stay quiet; making it noisy would bury the warning that
   * matters (the schema having no identifier field at all) in per-row chatter.
   */
  it('skips an entry whose identifier is blank silently', async () => {
    mock.state.existingIdentifiers = ['a.mp4'];
    const warnings = await preflightDuplicates(client, manifestWith('   '), mwdlSchema);
    expect(warnings).toHaveLength(0);
  });

  it('never modifies the manifest -- a duplicate is advisory only', async () => {
    mock.state.existingIdentifiers = ['a.mp4'];
    const manifest = manifestWith('a.mp4');
    const before = JSON.stringify(manifest);
    await preflightDuplicates(client, manifest, mwdlSchema);
    expect(JSON.stringify(manifest)).toBe(before);
  });

  it('survives a network failure without throwing, and warns the check could not complete', async () => {
    const manifest = manifestWith('a.mp4');
    await mock.close();
    const warnings = await preflightDuplicates(client, manifest, mwdlSchema);
    expect(warnings.join(' ')).toMatch(/could not|fail|error/i);
  });

  /**
   * The whole point of Task 8d. `MWDL/identifier` is BYU-Idaho's spelling; a
   * schema that calls the same field something else must still be checked,
   * not silently skipped row by row while the batch reports clean.
   */
  it('checks against a schema whose identifier is not called MWDL/identifier', async () => {
    mock.state.existingIdentifiers = ['a.mp4'];
    const schema = {
      titleHeader: 'local/dc/title',
      paths: new Set(['local/dc/title', 'local/dc/identifier', 'local/dc/subject']),
    };
    const warnings = await preflightDuplicates(
      client,
      manifestWith('a.mp4', 'local/dc/identifier'),
      schema,
    );
    expect(warnings.join(' ')).toMatch(/a\.mp4/);
  });

  /**
   * A check that cannot run must never look like one that ran and found
   * nothing. This is the exact failure recorded in
   * docs/superpowers/specs/2026-08-06-duplicate-prevention-design.md -- the
   * pre-flight read a field nobody filled in and "reported no duplicates by
   * never having looked."
   */
  it('says so, rather than reporting clean, when the schema has no identifier field', async () => {
    mock.state.existingIdentifiers = ['a.mp4'];
    const schema = {
      titleHeader: 'local/dc/title',
      paths: new Set(['local/dc/title', 'local/dc/subject']),
    };
    const warnings = await preflightDuplicates(client, manifestWith('a.mp4'), schema);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(NO_IDENTIFIER_PATH_WARNING);
    expect(warnings[0]).toMatch(/no identifier field/);
  });

  it('has nothing to report when a schema without an identifier field plans no rows', async () => {
    const empty = { ...manifestWith(undefined), entries: [] };
    const schema = { titleHeader: 'local/dc/title', paths: new Set(['local/dc/title']) };
    expect(await preflightDuplicates(client, empty, schema)).toHaveLength(0);
  });

  /**
   * An unauthenticated openEQUELLA does not refuse a search -- it answers 200
   * with nothing in it, so every identifier in the batch looks unused. A
   * pre-flight that reported that as clean would be lying with a straight
   * face, which is the same failure as reading a field nobody filled in
   * (docs/superpowers/specs/2026-08-06-duplicate-prevention-design.md).
   *
   * The session is checked ONCE for the batch, before any search, because the
   * answer cannot differ between rows.
   */
  describe('when nobody is signed in', () => {
    /** The real recorded guest response: 200, `guest: true`, not a 401. */
    const guest = JSON.parse(
      readFileSync('tests/fixtures/api/currentuser-guest.json', 'utf8'),
    ) as { username: string; firstName: string; lastName: string; guest: boolean };

    it('says the identifiers were not checked, rather than reporting them clean', async () => {
      mock.state.currentUser = guest;
      mock.state.existingIdentifiers = ['a.mp4'];
      const warnings = await preflightDuplicates(client, manifestWith('a.mp4'), mwdlSchema);
      expect(warnings).toEqual([GUEST_SESSION_WARNING]);
      expect(warnings[0]).toMatch(/signed in/i);
    });

    it('issues no search at all', async () => {
      mock.state.currentUser = guest;
      await preflightDuplicates(client, manifestWith('a.mp4'), mwdlSchema);
      expect(mock.state.searchUrls).toEqual([]);
    });

    it('warns once for the batch, not once per row', async () => {
      mock.state.currentUser = guest;
      const manifest = manifestWith('a.mp4');
      manifest.entries.push({ ...manifest.entries[0]!, rowNumber: 3, source: 'b.mp4', files: [{ path: 'b.mp4', name: 'b.mp4' }] });
      expect(await preflightDuplicates(client, manifest, mwdlSchema)).toHaveLength(1);
    });

    /** No identifier to check means no reason to ask who is signed in. */
    it('says nothing when no row carries an identifier to check', async () => {
      mock.state.currentUser = guest;
      expect(await preflightDuplicates(client, manifestWith(undefined), mwdlSchema)).toEqual([]);
    });

  });
});

describe('resolveIdentifierPath', () => {
  /**
   * The behaviour BYU-Idaho already has, pinned against the REAL bundled
   * schema rather than a hand-typed set -- this is the institution the check
   * currently works for, and Task 8d must not change what it sees.
   */
  it("resolves MWDL/identifier from BYU-Idaho's real schema export", async () => {
    const entity = await readFile('schema/_entity.xml', 'utf8');
    const schema = {
      titleHeader: extractItemNamePath(entity),
      paths: parseSchemaPaths(extractDefinition(entity)),
    };
    expect(resolveIdentifierPath(schema)).toBe('MWDL/identifier');
  });

  it('resolves an identifier under any section name', () => {
    expect(
      resolveIdentifierPath({
        titleHeader: 'local/dc/title',
        paths: new Set(['local/dc/title', 'local/dc/identifier']),
      }),
    ).toBe('local/dc/identifier');
  });

  /** The name path names the main section, so its identifier is the one meant. */
  it("prefers the section the schema's own name path lives in", () => {
    expect(
      resolveIdentifierPath({
        titleHeader: 'local/dc/title',
        paths: new Set(['local/dc/title', 'local/dc/identifier', 'MWDL/identifier']),
      }),
    ).toBe('local/dc/identifier');
  });

  it('is null when no path anywhere ends in identifier', () => {
    expect(
      resolveIdentifierPath({
        titleHeader: 'local/dc/title',
        paths: new Set(['local/dc/title', 'local/dc/subject']),
      }),
    ).toBeNull();
  });

  /** Undeclared name path is not a blocker: there is just no section to prefer. */
  it('still resolves an identifier when the schema declares no name path', () => {
    expect(
      resolveIdentifierPath({
        titleHeader: null,
        paths: new Set(['local/dc/title', 'local/dc/identifier']),
      }),
    ).toBe('local/dc/identifier');
  });
});

describe('markSkipped', () => {
  function twoRowManifest(): Manifest {
    return {
      version: 2,
      createdAt: '2026-08-06T00:00:00.000Z',
      baseUrl: 'https://example.test',
      collectionUuid: 'c1',
      schemaUuid: 's1',
      itemState: 'draft',
      attachmentColumn: 'attachment name',
      warnings: [],
      entries: [2, 3].map((rowNumber) => ({
        rowNumber,
        source: `${rowNumber}.pdf`,
        files: [{ path: `/f/${rowNumber}.pdf`, name: `${rowNumber}.pdf` }],
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

describe('buildManifest -- folder rows', () => {
  async function folder(name: string, files: Record<string, string>) {
    await mkdir(join(dir, name));
    for (const [f, body] of Object.entries(files)) await writeFile(join(dir, name, f), body);
  }

  it('plans a folder as one row holding its files in upload order, with sizes', async () => {
    await folder('Gazette_V2', { 'G_No10.pdf': 'aa', 'G_No9.pdf': 'a', 'Thumbs.db': 'x' });
    const m = await buildManifest(sheet([{ 'attachment name': 'Gazette_V2' }]), dir, paths, opts);
    const e = m.entries[0]!;
    expect(e.source).toBe('Gazette_V2');
    expect(e.folderPath).toBe(resolve(dir, 'Gazette_V2'));
    expect(e.files).toEqual([
      { path: join(resolve(dir, 'Gazette_V2'), 'G_No9.pdf'), name: 'G_No9.pdf', size: 1 },
      { path: join(resolve(dir, 'Gazette_V2'), 'G_No10.pdf'), name: 'G_No10.pdf', size: 2 },
    ]);
    expect(e.skippedFiles).toEqual([{ name: 'Thumbs.db', reason: 'a Windows thumbnail cache' }]);
  });

  it('matches a folder name case-blind, as a file name is', async () => {
    await folder('Gazette_V2', { 'a.pdf': 'a' });
    const m = await buildManifest(sheet([{ 'attachment name': 'gazette_v2' }]), dir, paths, opts);
    expect(m.entries[0]!.source).toBe('Gazette_V2');
  });

  it('records a size on a single-file row too, and no folder', async () => {
    const m = await buildManifest(sheet([{ 'attachment name': 'a.mp4' }]), dir, paths, opts);
    expect(m.entries[0]!.files[0]!.size).toBe(3);
    expect(m.entries[0]!.folderPath).toBeUndefined();
    expect(m.entries[0]!.skippedFiles).toBeUndefined();
  });

  it('skips a refused folder with its reason, never planning it short', async () => {
    await folder('Gazette_V3', { 'a.pdf': 'x' });
    await mkdir(join(dir, 'Gazette_V3', 'extra'));
    const m = await buildManifest(
      sheet([{ 'attachment name': 'Gazette_V3' }, { 'attachment name': 'a.mp4' }]),
      dir, paths, opts,
    );
    expect(m.entries.map((e) => e.source)).toEqual(['a.mp4']);
    expect(m.warnings).toContainEqual(
      expect.stringMatching(/^Row 2: folder 'Gazette_V3' cannot be uploaded: .*'extra'.*; skipped\.$/),
    );
  });

  it('skips an empty folder with its reason', async () => {
    await mkdir(join(dir, 'Gazette_V4'));
    const m = await buildManifest(
      sheet([{ 'attachment name': 'Gazette_V4' }, { 'attachment name': 'a.mp4' }]),
      dir, paths, opts,
    );
    expect(m.warnings).toContain(
      "Row 2: folder 'Gazette_V4' cannot be uploaded: the folder is empty; skipped.",
    );
  });

  it('warns about an unclaimed folder only when the batch uses folders', async () => {
    await folder('Gazette_V1', { 'a.pdf': 'x' });
    await folder('Gazette_V2', { 'a.pdf': 'x' });
    const m = await buildManifest(sheet([{ 'attachment name': 'Gazette_V1' }]), dir, paths, opts);
    expect(m.warnings).toContain("Folder 'Gazette_V2' has no matching row; not uploaded.");
  });

  it('stays silent about incidental folders in a file-only batch', async () => {
    await mkdir(join(dir, 'scratch'));
    const m = await buildManifest(sheet([{ 'attachment name': 'a.mp4' }]), dir, paths, opts);
    expect(m.warnings.some((w) => w.includes('scratch'))).toBe(false);
  });

  it('refuses two rows claiming one folder, as for a file', async () => {
    await folder('Gazette_V1', { 'a.pdf': 'x' });
    await expect(
      buildManifest(
        sheet([{ 'attachment name': 'Gazette_V1' }, { 'attachment name': 'gazette_v1' }]),
        dir, paths, opts,
      ),
    ).rejects.toThrow(/claimed by rows 2, 3/);
  });
});

describe('buildManifest -- attachment order', () => {
  const sheetWithOrder = (rows: Record<string, string>[]): Sheet => ({
    headers: ['attachment name', 'attachment order', 'MWDL/title'],
    rows: rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
  });
  async function folder(name: string, files: string[]) {
    await mkdir(join(dir, name));
    for (const f of files) await writeFile(join(dir, name, f), 'x');
  }

  it('attaches in the order the column gives, and never sends it as metadata', async () => {
    await folder('Gazette_V2', ['G_1972-73_No3.pdf', 'G_1972_No1.pdf', 'G_1972_No2.pdf']);
    const m = await buildManifest(
      sheetWithOrder([
        { 'attachment name': 'Gazette_V2', 'attachment order': 'G_1972_No1.pdf; G_1972_No2.pdf; G_1972-73_No3.pdf', 'MWDL/title': 'T' },
      ]),
      dir, paths, opts,
    );
    expect(m.entries[0]!.files.map((f) => f.name)).toEqual(['G_1972_No1.pdf', 'G_1972_No2.pdf', 'G_1972-73_No3.pdf']);
    expect(m.entries[0]!.metadata['attachment order']).toBeUndefined();
  });

  it('matches the names case-blind, as attachment name is', async () => {
    await folder('Gazette_V2', ['a.pdf', 'b.pdf']);
    const m = await buildManifest(
      sheetWithOrder([{ 'attachment name': 'Gazette_V2', 'attachment order': 'B.PDF;a.pdf', 'MWDL/title': 'T' }]),
      dir, paths, opts,
    );
    expect(m.entries[0]!.files.map((f) => f.name)).toEqual(['b.pdf', 'a.pdf']);
  });

  it('uses name order when the cell is blank', async () => {
    await folder('Gazette_V2', ['b.pdf', 'a.pdf']);
    const m = await buildManifest(
      sheetWithOrder([{ 'attachment name': 'Gazette_V2', 'attachment order': '', 'MWDL/title': 'T' }]),
      dir, paths, opts,
    );
    expect(m.entries[0]!.files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('refuses a row whose order does not name exactly the folder\'s files', async () => {
    await folder('Gazette_V2', ['a.pdf', 'b.pdf', 'c.pdf']);
    await writeFile(join(dir, 'other.pdf'), 'x');
    const m = await buildManifest(
      sheetWithOrder([
        { 'attachment name': 'Gazette_V2', 'attachment order': 'b.pdf; a.pdf; d.pdf; a.pdf', 'MWDL/title': 'T' },
        { 'attachment name': 'a.mp4', 'attachment order': '', 'MWDL/title': 'T' },
      ]),
      dir, paths, opts,
    );
    expect(m.entries.map((e) => e.source)).toEqual(['a.mp4']);
    expect(m.warnings).toContain(
      "Row 2: folder 'Gazette_V2' cannot be uploaded: its 'attachment order' does not match the folder " +
        "(not in the folder: d.pdf; listed twice: a.pdf; missing from the order: c.pdf) -- fix the column, " +
        'or clear it to use name order; skipped.',
    );
  });

  it('warns that an order on a single-file row is ignored', async () => {
    const m = await buildManifest(
      sheetWithOrder([{ 'attachment name': 'a.mp4', 'attachment order': 'a.mp4', 'MWDL/title': 'T' }]),
      dir, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(m.warnings).toContain(
      "Row 2: 'attachment order' applies only to a row naming a folder; ignored for 'a.mp4'.",
    );
  });
});

describe('applyFolderOrders', () => {
  const folderEntry = (rowNumber: number, names: string[]) => ({
    rowNumber,
    source: `V${rowNumber}`,
    folderPath: `/b/V${rowNumber}`,
    files: names.map((name) => ({ path: `/b/V${rowNumber}/${name}`, name, size: 1 })),
    metadata: {},
    status: 'pending' as RowStatus,
    attempts: 0,
  });
  const manifestOf = (...entries: ReturnType<typeof folderEntry>[]): Manifest => ({
    version: 2,
    createdAt: 'x',
    baseUrl: 'https://h',
    collectionUuid: 'c',
    schemaUuid: 's',
    itemState: 'draft',
    attachmentColumn: 'attachment name',
    warnings: [],
    entries,
  });

  it('reorders a folder row, keeping each file whole (path and size)', () => {
    const m = manifestOf(folderEntry(2, ['a.pdf', 'b.pdf', 'c.pdf']));
    expect(applyFolderOrders(m, { 2: ['c.pdf', 'a.pdf', 'b.pdf'] })).toBe(1);
    expect(m.entries[0]!.files).toEqual([
      { path: '/b/V2/c.pdf', name: 'c.pdf', size: 1 },
      { path: '/b/V2/a.pdf', name: 'a.pdf', size: 1 },
      { path: '/b/V2/b.pdf', name: 'b.pdf', size: 1 },
    ]);
  });

  it('refuses an order that does not name exactly the folder\'s files, changing nothing', () => {
    const m = manifestOf(folderEntry(2, ['a.pdf', 'b.pdf']), folderEntry(3, ['x.pdf', 'y.pdf']));
    expect(() => applyFolderOrders(m, { 3: ['y.pdf', 'x.pdf'], 2: ['b.pdf'] })).toThrow(
      "Row 2 (V2 (2 files)): the new attachment order does not match the folder (missing from the order: a.pdf)",
    );
    expect(m.entries[1]!.files.map((f) => f.name)).toEqual(['x.pdf', 'y.pdf']);
  });

  it('refuses an order for a row that is not a pending folder row', () => {
    const m = manifestOf({ ...folderEntry(2, ['a.pdf']), status: 'skipped' });
    expect(() => applyFolderOrders(m, { 2: ['a.pdf'] })).toThrow(/Row 2 is not a folder waiting to be uploaded/);
  });
});
