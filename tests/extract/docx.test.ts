// tests/extract/docx.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocx } from '../../src/core/extract/readers/docx.js';
import { makeDocx } from '../fixtures/extract/make.js';

async function write(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-docx-'));
  const path = join(dir, 'test.docx');
  await writeFile(path, bytes);
  return path;
}

describe('readDocx', () => {
  it('reads body text, one paragraph per line', async () => {
    const doc = await readDocx(await write(makeDocx({ text: 'Senior Recital\nPerformer: Jane Smith' })));
    expect(doc.text).toBe('Senior Recital\nPerformer: Jane Smith');
  });

  it('reads core properties', async () => {
    const doc = await readDocx(await write(makeDocx({ text: 'x', title: 'Recital', creator: 'Jane Smith' })));
    expect(doc.properties.title).toBe('Recital');
    expect(doc.properties.author).toBe('Jane Smith');
  });

  it('reports a text layer even for an empty document, because .docx always has one', async () => {
    expect((await readDocx(await write(makeDocx({ text: '' })))).hasTextLayer).toBe(true);
  });

  it('omits properties that are absent rather than returning empty strings', async () => {
    const doc = await readDocx(await write(makeDocx({ text: 'x' })));
    expect(doc.properties.title).toBeUndefined();
  });

  it('unescapes XML entities in the text', async () => {
    const doc = await readDocx(await write(makeDocx({ text: 'Bach & Handel' })));
    expect(doc.text).toBe('Bach & Handel');
  });

  it('fails with a clear message when the file is not a zip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-docx-'));
    const path = join(dir, 'broken.docx');
    await writeFile(path, 'this is not a zip');
    await expect(readDocx(path)).rejects.toThrow(/not a readable \.docx/i);
  });
});
