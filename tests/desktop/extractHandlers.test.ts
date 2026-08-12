// tests/desktop/extractHandlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerExtractHandlers, __resetExtractCache } from '../../src/desktop/extractHandlers.js';
import { makeDocx, makePdf } from '../fixtures/extract/make.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';
import type { SchemaInfo } from '../../src/core/discovery.js';

/** A stand-in for Electron's ipcMain that just records the handlers. */
function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
  return {
    handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown) {
      handlers.set(channel, fn);
    },
    call<T>(channel: string, ...args: unknown[]): Promise<T> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return Promise.resolve(fn({}, ...args) as T);
    },
    channels: () => [...handlers.keys()],
  };
}

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
  await writeFile(join(dir, 'Recital.pdf'), makePdf({ text: 'Performer: Jane Smith' }));
  await writeFile(join(dir, 'notes.txt'), 'x');
  return dir;
}

describe('extract handlers', () => {
  beforeEach(() => __resetExtractCache());

  it('registers every extract channel', () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    expect(ipc.channels()).toEqual(
      expect.arrayContaining([
        'oeq:extractScan', 'oeq:extractPreview', 'oeq:extractRun', 'oeq:schemaPaths',
        'oeq:schemaNamePath', 'oeq:listTemplates', 'oeq:loadTemplate',
      ]),
    );
  });

  /**
   * The picker leads with the section this path names. Parsed here, in the
   * main process, because reading the schema reaches `node:fs` -- an import
   * the sandboxed renderer cannot survive.
   */
  it('reports the xpath the schema declares as the item name', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    expect(await ipc.call<string | null>('oeq:schemaNamePath')).toBe('MWDL/title');
  });

  it('scan reports supported files, skipped files and the labels it found', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const scan = await ipc.call<{ supported: string[]; skipped: { file: string }[]; labels: string[] }>(
      'oeq:extractScan', await folder(),
    );
    expect(scan.supported).toEqual(['Recital.pdf']);
    expect(scan.skipped.map((s) => s.file)).toEqual(['notes.txt']);
    expect(scan.labels).toContain('Performer');
  });

  /**
   * The whole point of the section tier, end to end: a PDF with an abstract and
   * nothing else must arrive with a description already filled in, without the
   * operator mapping anything. Twelve real journal PDFs came out blank before.
   */
  it('scan proposes an abstract as the description, and the preview fills it', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    await writeFile(
      join(dir, 'Article.pdf'),
      makePdf({ text: 'Abstract This paper measures jump height. Keywords sport, jumping' }),
    );

    const scan = await ipc.call<{ sections: string[]; starter: Profile }>('oeq:extractScan', dir);
    expect(scan.sections).toContain('Abstract');
    expect(scan.starter.columns.find((c) => c.path === 'MWDL/description')?.sources).toEqual([
      { section: 'Abstract' },
      { opening: true },
    ]);

    const rows = await ipc.call<{ cells: Record<string, string> }[]>('oeq:extractPreview', {
      dir,
      profile: scan.starter,
    });
    expect(rows[0]?.cells['MWDL/description']).toBe('This paper measures jump height.');
  });

  it('preview returns rows without writing anything', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const dir = await folder();
    const rows = await ipc.call<{ cells: Record<string, string> }[]>('oeq:extractPreview', { dir, profile });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cells['MWDL/title']).toBe('Recital');
  });

  it('preview caps how many rows it builds', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    for (let i = 0; i < 9; i++) await writeFile(join(dir, `f${i}.pdf`), makePdf({ text: 'x' }));
    const rows = await ipc.call<unknown[]>('oeq:extractPreview', { dir, profile });
    expect(rows).toHaveLength(5);
  });

  it('run writes the file and reports what needs review', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const dir = await folder();
    const outPath = join(dir, 'out.csv');
    const report = await ipc.call<{ written: number; flagged: number; outPath: string }>(
      'oeq:extractRun', { dir, profile, outPath },
    );
    expect(report.written).toBe(1);
    expect(report.outPath).toBe(outPath);
    const { readSheet } = await import('../../src/core/sheet.js');
    expect((await readSheet(outPath)).rows).toHaveLength(1);
  });

  it('schemaPaths returns the real schema leaf paths', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const paths = await ipc.call<string[]>('oeq:schemaPaths');
    expect(paths).toContain('MWDL/title');
    expect(paths.length).toBeGreaterThan(100);
  });
});

/**
 * `src/core/extract/` NEVER TOUCHES THE NETWORK -- that is what lets an
 * operator build a spreadsheet from a folder of files without signing in to
 * anything -- but the schema it validates columns against now comes from the
 * API. `SchemaCache` is what reconciles those: whoever signed in leaves the
 * schema on disk, and extraction reads it later, offline.
 */
describe('extract handlers and the cached schema', () => {
  beforeEach(() => __resetExtractCache());

  const cached: SchemaInfo = {
    uuid: 'schema-1',
    namePath: '/OTHER/name',
    titleHeader: 'OTHER/name',
    paths: new Set(['OTHER/name', 'OTHER/summary']),
  };

  const withCache = (ipc: ReturnType<typeof fakeIpcMain>, fn: (id: string) => Promise<SchemaInfo | null>) =>
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      cachedSchema: fn,
    });

  it('validates against the instance’s own cached schema, not the bundled export', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => cached);
    const paths = await ipc.call<string[]>('oeq:schemaPaths', 'https://other.example.edu');
    expect(paths).toEqual(['OTHER/name', 'OTHER/summary']);
    // The bundled export is BYU-Idaho's, and correct nowhere else.
    expect(paths).not.toContain('MWDL/title');
  });

  it('reads the item name path from the cached schema too, in header form', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => cached);
    expect(await ipc.call<string | null>('oeq:schemaNamePath', 'https://other.example.edu')).toBe('OTHER/name');
  });

  /**
   * THE REQUIREMENT THAT MATTERS MOST. A missing cache -- a fresh install,
   * another institution's site, an operator who has never signed in -- must
   * degrade to the bundled export, never to a refusal. Blocking the offline
   * half of the tool on a network call nobody asked for would trade a real
   * capability for a check.
   */
  it('still runs with no cache at all, falling back to the bundled export', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => null);
    const paths = await ipc.call<string[]>('oeq:schemaPaths', 'https://oeq.example.edu');
    expect(paths).toContain('MWDL/title');
    expect(paths.length).toBeGreaterThan(100);
  });

  it('still runs when no instance is named at all', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => cached);
    expect(await ipc.call<string[]>('oeq:schemaPaths')).toContain('MWDL/title');
  });

  // A cache lookup that throws is "no cache", for exactly the same reason.
  it('still runs when the cache lookup itself fails', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => {
      throw new Error('disk gone');
    });
    const paths = await ipc.call<string[]>('oeq:schemaPaths', 'https://oeq.example.edu');
    expect(paths).toContain('MWDL/title');
  });

  /**
   * The scan's proposed starter profile is built against the SAME schema the
   * Add-column picker uses. Two different schemas here would have the starter
   * propose a column the picker then reports as invalid.
   *
   * A table heading is what exercises it: `starterProfile` maps a heading onto
   * a schema path by matching its last word (core/extract/suggest.ts), so
   * "Summary" resolves to `OTHER/summary` from the cached schema -- a path the
   * bundled BYU-Idaho export does not contain at all.
   */
  it('builds the starter profile against the cached schema', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => cached);
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    await writeFile(
      join(dir, 'Record.docx'),
      makeDocx({ table: [['Summary'], ['A short account of the thing.']] }),
    );

    const scan = await ipc.call<{ tableColumns: string[]; starter: Profile }>(
      'oeq:extractScan', dir, 'https://other.example.edu',
    );
    expect(scan.tableColumns).toContain('Summary');
    expect(scan.starter.columns.map((c) => c.path)).toContain('OTHER/summary');
  });

  it('builds it against the bundled export when there is no cache', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => null);
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    await writeFile(
      join(dir, 'Record.docx'),
      makeDocx({ table: [['Summary'], ['A short account of the thing.']] }),
    );

    const scan = await ipc.call<{ starter: Profile }>('oeq:extractScan', dir, 'https://other.example.edu');
    expect(scan.starter.columns.map((c) => c.path)).not.toContain('OTHER/summary');
  });
});
