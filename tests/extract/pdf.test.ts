// tests/extract/pdf.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPdf } from '../../src/core/extract/readers/pdf.js';
import { makePdf } from '../fixtures/extract/make.js';

async function write(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-pdf-'));
  const path = join(dir, 'test.pdf');
  await writeFile(path, bytes);
  return path;
}

describe('readPdf', () => {
  it('reads the text layer', async () => {
    const doc = await readPdf(await write(makePdf({ text: 'Performer: Jane Smith' })));
    expect(doc.text).toContain('Performer: Jane Smith');
    expect(doc.hasTextLayer).toBe(true);
  });

  it('reads document properties', async () => {
    const doc = await readPdf(await write(makePdf({ text: 'x', title: 'Recital', author: 'Jane Smith' })));
    expect(doc.properties.title).toBe('Recital');
    expect(doc.properties.author).toBe('Jane Smith');
  });

  it('reports no text layer for a page with no text, and does not throw', async () => {
    const doc = await readPdf(await write(makePdf({})));
    expect(doc.hasTextLayer).toBe(false);
    expect(doc.text).toBe('');
  });

  it('still returns properties when there is no text layer', async () => {
    const doc = await readPdf(await write(makePdf({ title: 'Scanned Programme' })));
    expect(doc.hasTextLayer).toBe(false);
    expect(doc.properties.title).toBe('Scanned Programme');
  });

  // Every PDF stores dates in this syntax -- it is not an edge case, it is the
  // only case. Found by running against a real folder: the date column came
  // out as "D:20260803230446+00'00'" on all nine files. Converted here in the
  // reader, because the format is a PDF concern and nothing downstream should
  // have to know about it.
  it('converts a PDF-syntax creation date to a plain ISO date', async () => {
    const doc = await readPdf(await write(makePdf({ text: 'x', created: "D:20260803230446+00'00'" })));
    expect(doc.properties.created).toBe('2026-08-03');
  });

  it('converts a PDF date with no timezone suffix', async () => {
    const doc = await readPdf(await write(makePdf({ text: 'x', created: 'D:19530412000000' })));
    expect(doc.properties.created).toBe('1953-04-12');
  });

  it('keeps a creation date it cannot parse rather than dropping it', async () => {
    const doc = await readPdf(await write(makePdf({ text: 'x', created: 'sometime last spring' })));
    expect(doc.properties.created).toBe('sometime last spring');
  });

  it('fails with a clear message when the file is not a PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-pdf-'));
    const path = join(dir, 'broken.pdf');
    await writeFile(path, 'not a pdf at all');
    await expect(readPdf(path)).rejects.toThrow(/not a readable PDF/i);
  });
});
