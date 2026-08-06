// tests/extract/sections.test.ts
import { describe, it, expect } from 'vitest';
import { findSections, readSection } from '../../src/core/extract/sections.js';

/**
 * A description often sits under a heading rather than in a field: journal
 * articles put it under "Abstract", reports under "Summary" or "Overview".
 * Reading the text between that heading and the next one gets it without
 * inventing anything -- the document marked the boundaries itself.
 */

const article =
  'Academic Editor: C. Peham Received: 24 August 2025 Citation: Ibanez, S.J. ' +
  'Abstract Basketball is a high-intensity, intermittent sport in which demands ' +
  'fluctuate. The present study aimed to identify key variables. ' +
  'Keywords: basketball; workload ' +
  'Introduction Team sports have long been studied.';

describe('findSections', () => {
  it('reports which known headings a document contains', () => {
    expect(findSections(article)).toEqual(['Abstract']);
  });

  it('finds several, in the order they appear', () => {
    expect(findSections('Overview one thing. Summary another thing.')).toEqual([
      'Overview',
      'Summary',
    ]);
  });

  it('reports nothing for a document with no known heading', () => {
    expect(findSections('Just some prose with no structure at all.')).toEqual([]);
  });

  it('does not match a heading word inside a longer word', () => {
    expect(findSections('The Abstracted form is different.')).toEqual([]);
  });
});

describe('readSection', () => {
  it('reads the text between the heading and the next known heading', () => {
    const { text } = readSection(article, 'Abstract');
    expect(text).toContain('Basketball is a high-intensity');
    expect(text).toContain('identify key variables');
    // Stops at Keywords -- the next heading, not the end of the document.
    expect(text).not.toContain('basketball; workload');
    expect(text).not.toContain('Team sports have long been studied');
  });

  it('stops at Introduction when there is no Keywords heading', () => {
    const { text } = readSection('Abstract This is the summary. Introduction Then this.', 'Abstract');
    expect(text).toBe('This is the summary.');
  });

  it('stops at Methods when that comes first', () => {
    const { text } = readSection('Abstract A summary here. Methods And the method.', 'Abstract');
    expect(text).toBe('A summary here.');
  });

  it('returns nothing when the heading is absent', () => {
    expect(readSection('No such heading in here.', 'Abstract').text).toBe('');
  });

  it('drops a colon straight after the heading', () => {
    expect(readSection('Summary: the point of it. Introduction next.', 'Summary').text).toBe(
      'the point of it.',
    );
  });

  // A document with a heading and nothing after it would otherwise return the
  // entire remainder of the file.
  it('caps a section that never reaches another heading, and says it did', () => {
    const long = `Abstract ${'word '.repeat(3000)}`;
    const { text, capped } = readSection(long, 'Abstract');
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.length).toBeGreaterThan(100);
    expect(capped).toBe(true);
  });

  // A section that ended at a heading is a section. One that ran to the cap
  // never ended, which usually means the heading was not a heading at all --
  // a benefits PDF matched "Summary" mid-page and produced 3,996 characters
  // of plan tables as its description.
  it('reports a section that ended properly as not capped', () => {
    expect(readSection(article, 'Abstract').capped).toBe(false);
    expect(readSection('No such heading here.', 'Abstract').capped).toBe(false);
  });

  it('ignores case in the heading', () => {
    expect(readSection('ABSTRACT the summary. Keywords x', 'Abstract').text).toBe('the summary.');
  });

  it('returns nothing when the heading is the last thing in the document', () => {
    expect(readSection('Some text. Abstract', 'Abstract').text).toBe('');
  });
});

/**
 * What twelve real journal PDFs do at the edges of an abstract.
 *
 * Nine of the twelve ended cleanly on the first build. These are the three that
 * did not, each reduced to the shape that caused it.
 */
describe('readSection against real journal furniture', () => {
  it('stops at the citation block a journal appends to its abstract', () => {
    const article =
      'Abstract The aim of this study was to reduce dimensionality. ' +
      'How to cite this article Teixeira JE, Forte P. 2023. PeerJ 11:e15806 ' +
      'Submitted 26 January 2023 Accepted 7 July 2023 Copyright 2023 Teixeira et al.';
    expect(readSection(article, 'Abstract').text).toBe(
      'The aim of this study was to reduce dimensionality.',
    );
  });

  it('stops at a "Key words" list, spelled as two words', () => {
    const article = 'Abstract Each position showed specific demands. Key words : basketball, PCA.';
    expect(readSection(article, 'Abstract').text).toBe('Each position showed specific demands.');
  });

  // The running head a journal stamps on every page lands in the extracted
  // text wherever the page happened to break.
  it('drops a journal footer left at the end', () => {
    const withFooter =
      'Abstract Training load needs to be carefully managed. ' +
      'Sports 2024 , 12 , 194. https://doi.org/10.3390/sports12070194\nSports 2024 , 12 , 194 2 of 15';
    expect(readSection(withFooter, 'Abstract').text).toBe(
      'Training load needs to be carefully managed.',
    );
  });

  it('drops a footer on its own line', () => {
    const withFooter =
      'Abstract Insights into the demands placed on players.\n' +
      'PLOS One | https://doi.org/10.1371/journal.pone.0332500 October 8, 2025 2 / 15';
    expect(readSection(withFooter, 'Abstract').text).toBe(
      'Insights into the demands placed on players.',
    );
  });

  /**
   * A footer INSIDE an abstract must not truncate it. One article's abstract
   * runs across a page break, so the running head sits in the middle with real
   * abstract text on both sides. Trimming is a tail operation only.
   */
  it('keeps text that follows a footer mid-abstract', () => {
    const across =
      'Abstract High-intensity variables showed strong loadings. ' +
      'Sensors 2025 , 25 , 6253 https://doi.org/10.3390/s25196253\n' +
      'Sensors 2025 , 25 , 6253 2 of 17 Guards required seven components to explain the variance.';
    const { text } = readSection(across, 'Abstract');
    expect(text).toContain('High-intensity variables');
    expect(text).toContain('Guards required seven components');
  });

  /**
   * "The purpose of this study was to..." is a sentence, not a heading. Taking
   * the text after the word alone produced a cell starting "of this study was
   * to describe", which is both ugly and a sign the match was not a heading.
   */
  it('keeps the sentence when the heading is really a word inside one', () => {
    const article = 'Luka Svilar 2 The purpose of this study was to describe the demands. Key words : x';
    const { text, midSentence } = readSection(article, 'Purpose');
    expect(text).toBe('The purpose of this study was to describe the demands.');
    expect(midSentence).toBe(true);
  });

  it('reports a real heading as not mid-sentence', () => {
    expect(readSection('Abstract A study of jumping. Keywords x', 'Abstract').midSentence).toBe(false);
  });
});
