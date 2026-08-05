// tests/extract/extract.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFolder } from '../../src/core/extract/extract.js';
import { ATTACHMENT_COLUMN, type DocumentData, type Profile } from '../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

const emptyDoc: DocumentData = { text: '', hasTextLayer: true, properties: {} };

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
