// tests/extract/extract.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { extractFolder, extractFolders, listSubfolders } from '../../src/core/extract/extract.js';
import { ATTACHMENT_COLUMN, type DocumentData, type Profile } from '../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

const emptyDoc: DocumentData = { text: '', hasTextLayer: true, properties: {}, tables: [] };

async function folderWith(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-extract-'));
  for (const name of names) await writeFile(join(dir, name), 'x');
  return dir;
}

describe('extractFolder', () => {
  it('produces one row per supported file, sorted by name', async () => {
    const dir = await folderWith(['b.pdf', 'a.pdf']);
    const result = await extractFolder(dir, profile, { reader: async () => emptyDoc });
    expect(result.rows.map((r) => r.cells[ATTACHMENT_COLUMN])).toEqual(['a.pdf', 'b.pdf']);
  });

  it('skips unsupported files and says why', async () => {
    const dir = await folderWith(['a.pdf', 'notes.txt', 'old.doc']);
    const result = await extractFolder(dir, profile, { reader: async () => emptyDoc });
    expect(result.rows).toHaveLength(1);
    expect(result.skipped.map((s) => s.file).sort()).toEqual(['notes.txt', 'old.doc']);
    expect(result.skipped.find((s) => s.file === 'old.doc')?.reason).toMatch(/\.docx/i);
  });

  it('keeps going when one file fails to read, and records the failure', async () => {
    const dir = await folderWith(['good.pdf', 'bad.pdf']);
    const reader = vi.fn(async (path: string) => {
      if (path.endsWith('bad.pdf')) throw new Error('corrupt');
      return emptyDoc;
    });
    const result = await extractFolder(dir, profile, { reader });
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toEqual([{ file: 'bad.pdf', reason: 'corrupt' }]);
  });

  it('reports progress for every file it reads', async () => {
    const dir = await folderWith(['a.pdf', 'b.pdf']);
    const seen: number[] = [];
    await extractFolder(dir, profile, {
      reader: async () => emptyDoc,
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(2);
      },
    });
    expect(seen).toEqual([1, 2]);
  });

  it('returns empty results for an empty folder rather than throwing', async () => {
    const result = await extractFolder(await folderWith([]), profile, { reader: async () => emptyDoc });
    expect(result).toEqual({ rows: [], skipped: [] });
  });

  it('ignores subdirectories', async () => {
    const dir = await folderWith(['a.pdf']);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'sub.pdf'));
    const result = await extractFolder(dir, profile, { reader: async () => emptyDoc });
    expect(result.rows).toHaveLength(1);
  });

  it('stops early when the signal is aborted', async () => {
    const dir = await folderWith(['a.pdf', 'b.pdf', 'c.pdf']);
    const controller = new AbortController();
    const result = await extractFolder(dir, profile, {
      reader: async () => {
        controller.abort();
        return emptyDoc;
      },
      signal: controller.signal,
    });
    expect(result.rows).toHaveLength(1);
  });
});

describe('extractFolders', () => {
  const folderProfile: Profile = {
    version: 1,
    pattern: 'Gazette_V{volume}',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ property: 'title' }] },
    ],
  };

  async function batch(layout: Record<string, string[] | null>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-extract-folders-'));
    for (const [name, files] of Object.entries(layout)) {
      if (files === null) {
        await writeFile(join(dir, name), 'x');
        continue;
      }
      await mkdir(join(dir, name));
      for (const f of files) await writeFile(join(dir, name, f), 'x');
    }
    return dir;
  }

  it('builds one row per subfolder, in natural order, reading files in attachment order', async () => {
    const dir = await batch({
      Gazette_V10: ['a.pdf'],
      Gazette_V2: ['b.pdf', 'a.pdf'],
      Gazette_V3: [],
      'loose.pdf': null,
    });
    const calls: string[] = [];
    const reader = async (p: string) => {
      calls.push(p.slice(dir.length + 1).split('\\').join('/'));
      return { ...emptyDoc, properties: { title: basename(p) } };
    };
    const result = await extractFolders(dir, folderProfile, { reader });
    expect(result.rows.map((r) => r.cells[ATTACHMENT_COLUMN])).toEqual(['Gazette_V2', 'Gazette_V10']);
    expect(calls).toEqual(['Gazette_V2/a.pdf', 'Gazette_V2/b.pdf', 'Gazette_V10/a.pdf']);
    expect(result.rows[0]!.cells['MWDL/title']).toBe('a.pdf');
    expect(result.skipped).toEqual([
      {
        file: 'loose.pdf',
        reason: 'a file directly in the chosen folder -- with one row per subfolder, only subfolders become rows',
      },
      { file: 'Gazette_V3', reason: 'the folder is empty' },
    ]);
  });

  it('keeps an unreadable file as an attachment and notes it on the row', async () => {
    const dir = await batch({ Gazette_V2: ['bad.pdf', 'good.pdf'] });
    const reader = async (p: string) => {
      if (p.endsWith('bad.pdf')) throw new Error('boom');
      return emptyDoc;
    };
    const result = await extractFolders(dir, folderProfile, { reader });
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(result.rows[0]!.notes).toContain(
      "'bad.pdf' could not be read (boom); it is still uploaded with the others",
    );
  });

  it('reads only supported files; an unsupported one is still an attachment and refuses nothing', async () => {
    const dir = await batch({ Gazette_V2: ['a.pdf', 'cover.jpg'] });
    const reader = vi.fn(async () => emptyDoc);
    const result = await extractFolders(dir, folderProfile, { reader });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it('lists subfolders the same way the run reads them', async () => {
    const dir = await batch({ Gazette_V2: ['a.pdf', 'cover.jpg'], 'Thumbs.db': null });
    expect(await listSubfolders(dir)).toEqual({
      folders: [{ name: 'Gazette_V2', files: ['a.pdf', 'cover.jpg'], readable: ['a.pdf'] }],
      skipped: [],
    });
  });

  it('reports progress per folder', async () => {
    const dir = await batch({ Gazette_V1: ['a.pdf'], Gazette_V2: ['a.pdf'] });
    const seen: [number, number][] = [];
    await extractFolders(dir, folderProfile, {
      reader: async () => emptyDoc,
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
