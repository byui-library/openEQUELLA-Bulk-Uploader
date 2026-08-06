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

  // Real Word documents from this institution hold their metadata as a table:
  // a header row naming the fields, then one row of values. Flattening that to
  // lines loses the cell boundaries -- a cell with four paragraphs becomes four
  // lines and nothing says where the next field starts -- so the table has to
  // survive the reader intact.
  it('reads a table as its header row and the rows beneath it', async () => {
    const doc = await readDocx(
      await write(
        makeDocx({
          text: '',
          table: [
            ['Company', 'Job Title', 'Date'],
            ['Banner Health', 'Associate Director', '06/05/2026'],
          ],
        }),
      ),
    );
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0]?.headers).toEqual(['Company', 'Job Title', 'Date']);
    expect(doc.tables[0]?.rows).toEqual([['Banner Health', 'Associate Director', '06/05/2026']]);
  });

  it('keeps a multi-paragraph cell together as one value', async () => {
    const doc = await readDocx(
      await write(
        makeDocx({
          table: [
            ['Description'],
            ['First paragraph.\nSecond paragraph.\nThird.'],
          ],
        }),
      ),
    );
    expect(doc.tables[0]?.rows[0]?.[0]).toBe('First paragraph.\nSecond paragraph.\nThird.');
  });

  it('reports no tables for a document that has none', async () => {
    expect((await readDocx(await write(makeDocx({ text: 'Just prose' })))).tables).toEqual([]);
  });

  it('reads several tables, and a table with only a header row', async () => {
    const doc = await readDocx(
      await write(makeDocx({ table: [['A', 'B']] })),
    );
    expect(doc.tables[0]?.headers).toEqual(['A', 'B']);
    expect(doc.tables[0]?.rows).toEqual([]);
  });

  it('still returns the body text alongside the table', async () => {
    const doc = await readDocx(
      await write(makeDocx({ text: 'Heading line', table: [['A'], ['1']] })),
    );
    expect(doc.text).toContain('Heading line');
  });

  it('fails with a clear message when the file is not a zip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-docx-'));
    const path = join(dir, 'broken.docx');
    await writeFile(path, 'this is not a zip');
    await expect(readDocx(path)).rejects.toThrow(/not a readable \.docx/i);
  });
});
