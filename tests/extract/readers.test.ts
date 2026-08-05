// tests/extract/readers.test.ts
import { describe, it, expect } from 'vitest';
import { isSupported, readDocument, SUPPORTED_EXTENSIONS } from '../../src/core/extract/readers/index.js';

describe('isSupported', () => {
  it('accepts pdf and docx in any case', () => {
    expect(isSupported('a.pdf')).toBe(true);
    expect(isSupported('a.PDF')).toBe(true);
    expect(isSupported('a.docx')).toBe(true);
  });

  it('rejects legacy .doc, which has no reliable reader', () => {
    expect(isSupported('a.doc')).toBe(false);
  });

  it('rejects anything else', () => {
    expect(isSupported('a.mp4')).toBe(false);
    expect(isSupported('noextension')).toBe(false);
  });

  it('lists exactly the extensions it supports', () => {
    expect([...SUPPORTED_EXTENSIONS].sort()).toEqual(['.docx', '.pdf']);
  });
});

describe('readDocument', () => {
  it('refuses an unsupported file by name, without reading it', async () => {
    await expect(readDocument('C:/nonexistent/thing.doc')).rejects.toThrow(/\.doc files/i);
  });
});
