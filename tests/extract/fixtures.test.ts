// tests/extract/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { makePdf, makeDocx } from '../fixtures/extract/make.js';

describe('makePdf', () => {
  it('produces something that starts with a PDF header and ends with EOF', () => {
    const bytes = strFromU8(makePdf({ text: 'hello' }));
    expect(bytes.startsWith('%PDF-')).toBe(true);
    expect(bytes.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('records a byte offset for every object in the xref table', () => {
    const bytes = strFromU8(makePdf({ text: 'hello' }));
    const entries = bytes.match(/^\d{10} 00000 n $/gm) ?? [];
    expect(entries).toHaveLength(6);
  });
});

describe('makeDocx', () => {
  it('produces a zip containing the two parts the reader needs', () => {
    const entries = Object.keys(unzipSync(makeDocx({ text: 'hello' })));
    expect(entries).toContain('docProps/core.xml');
    expect(entries).toContain('word/document.xml');
  });
});
