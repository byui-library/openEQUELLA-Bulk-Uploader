// tests/extract/pdfCleanup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A pdf.js loading task owns a worker. If `task.promise` rejects and nobody
 * calls `task.destroy()`, that worker stays alive for the life of the process
 * -- and extraction runs over a WHOLE FOLDER, so a batch containing several
 * unreadable PDFs leaked one apiece.
 *
 * pdf.js is mocked here because the leak is about which cleanup call happens
 * on which path, which a real PDF cannot show us. Mocked in its own file so
 * pdf.test.ts keeps exercising the real library end to end.
 */
const state = {
  reject: true,
  destroyed: 0,
  destroyThrows: false,
};

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: state.reject
      ? Promise.reject(new Error('InvalidPDFException: Invalid PDF structure.'))
      : Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'hello' }] }) }),
          getMetadata: async () => ({ info: {} }),
        }),
    destroy: async () => {
      state.destroyed++;
      if (state.destroyThrows) throw new Error('worker terminated before destroy');
    },
  }),
}));

const { readPdf } = await import('../../src/core/extract/readers/pdf.js');

async function somePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-pdf-cleanup-'));
  const path = join(dir, 'broken.pdf');
  await writeFile(path, 'irrelevant, getDocument is mocked');
  return path;
}

beforeEach(() => {
  state.reject = true;
  state.destroyed = 0;
  state.destroyThrows = false;
});

describe('readPdf cleanup', () => {
  it('destroys the loading task when the PDF cannot be parsed', async () => {
    await expect(readPdf(await somePath())).rejects.toThrow(/not a readable PDF/i);
    expect(state.destroyed).toBe(1);
  });

  it('destroys the loading task on the success path too', async () => {
    state.reject = false;
    await readPdf(await somePath());
    expect(state.destroyed).toBe(1);
  });

  /**
   * The operator needs to know WHICH FILE was unreadable. A cleanup failure
   * reported in its place would send them looking at the wrong thing -- and
   * cleanup is the less interesting of the two failures by a wide margin.
   */
  it('does not let a cleanup failure mask the parse error', async () => {
    state.destroyThrows = true;
    await expect(readPdf(await somePath())).rejects.toThrow(/not a readable PDF/i);
    expect(state.destroyed).toBe(1);
  });
});
