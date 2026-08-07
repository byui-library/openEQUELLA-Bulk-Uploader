// tests/desktop/extractHandlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerExtractHandlers, __resetExtractCache } from '../../src/desktop/extractHandlers.js';
import { makePdf } from '../fixtures/extract/make.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';

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
        'oeq:listTemplates', 'oeq:loadTemplate',
      ]),
    );
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
