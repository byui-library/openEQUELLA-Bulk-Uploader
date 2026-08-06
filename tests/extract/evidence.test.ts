// tests/extract/evidence.test.ts
import { describe, it, expect } from 'vitest';
import { evidenceFrom, spreadAcrossTypes } from '../../src/core/extract/evidence.js';
import type { DocumentData } from '../../src/core/extract/types.js';

/**
 * What a scan learns from a folder, so that both front ends learn the same
 * things. This lived inside the desktop's IPC handler, which meant the CLI's
 * --init-profile knew none of it: a CLI-built profile had an EMPTY description
 * column, and every fix for descriptions reached only the GUI. Found by running
 * the extract -> plan round trip, not by any unit test.
 */

const doc = (over: Partial<DocumentData> = {}): DocumentData => ({
  text: '',
  hasTextLayer: true,
  properties: {},
  tables: [],
  ...over,
});

describe('evidenceFrom', () => {
  it('collects the headings a description could be read from', () => {
    const found = evidenceFrom([doc({ text: 'Abstract A study of jumping. Keywords sport' })]);
    expect(found.sections).toEqual(['Abstract']);
  });

  it('ignores a heading with nothing under it', () => {
    expect(evidenceFrom([doc({ text: 'Some text. Abstract' })]).sections).toEqual([]);
  });

  it('collects table headers that have a value beneath them', () => {
    const withTable = doc({
      tables: [{ headers: ['Job Title', 'Pay', 'Empty'], rows: [['Nurse', '$30', '']] }],
    });
    expect(evidenceFrom([withTable]).tableColumns).toEqual(['Job Title', 'Pay']);
  });

  it('collects document properties that are present', () => {
    const found = evidenceFrom([doc({ properties: { title: 'A Title' } })]);
    expect(found.properties).toContain('title');
    expect(found.properties).not.toContain('author');
  });

  it('collects labels found in the text', () => {
    expect(evidenceFrom([doc({ text: 'Performer: Jane Smith' })]).labels).toContain('Performer');
  });

  it('merges what several documents each contribute', () => {
    const found = evidenceFrom([
      doc({ text: 'Abstract One study. Keywords x' }),
      doc({ properties: { author: 'A. Person' } }),
    ]);
    expect(found.sections).toEqual(['Abstract']);
    expect(found.properties).toEqual(['author']);
  });
});

describe('spreadAcrossTypes', () => {
  // Sorted alphabetically, twelve PDFs come before eighteen Word files, so
  // taking the first five gives five PDFs and learns nothing about the tables
  // the Word files keep their metadata in.
  it('represents every file type before giving any type a second slot', () => {
    const names = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'x.docx', 'y.docx'];
    expect(spreadAcrossTypes(names, 4)).toEqual(['a.pdf', 'x.docx', 'b.pdf', 'y.docx']);
  });

  it('takes what it can when one type runs out', () => {
    expect(spreadAcrossTypes(['a.pdf', 'b.pdf'], 5)).toEqual(['a.pdf', 'b.pdf']);
  });
});
