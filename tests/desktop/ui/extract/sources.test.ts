// tests/desktop/ui/extract/sources.test.ts
import { describe, it, expect } from 'vitest';
import { sourceOptions, describeSource } from '../../../../src/desktop/ui/extract/sources.js';
import { ATTACHMENT_COLUMN } from '../../../../src/core/extract/types.js';

const scan = { supported: ['a.pdf'], skipped: [], labels: ['Performer'], properties: ['title', 'created'], tableColumns: ['Company'], sections: ['Abstract'], starter: { version: 1 as const, pattern: '{part1}.pdf', columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true as const }], locked: true }] } };

describe('sourceOptions', () => {
  it('offers one option per placeholder in the pattern', () => {
    const options = sourceOptions('{last}_{first}.pdf', scan);
    expect(options.filter((o) => 'placeholder' in o.source).map((o) => o.label))
      .toEqual(['Filename part: last', 'Filename part: first']);
  });

  it('offers only labels that were actually found', () => {
    expect(sourceOptions('{a}.pdf', scan).some((o) => o.label === 'Label in document: Performer')).toBe(true);
    expect(sourceOptions('{a}.pdf', scan).some((o) => o.label.includes('Composer'))).toBe(false);
  });

  it('offers only properties that were actually present', () => {
    const labels = sourceOptions('{a}.pdf', scan).map((o) => o.label);
    expect(labels).toContain('Document property: title');
    expect(labels).not.toContain('Document property: author');
  });

  // The opening survives an empty scan because it is not evidence: every
  // document that has text has a start, so there is nothing to find first.
  it('offers nothing from an empty scan except the placeholders and the opening', () => {
    const empty = { supported: [], skipped: [], labels: [], properties: [], tableColumns: [], sections: [], starter: { version: 1 as const, pattern: '{part1}.pdf', columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true as const }], locked: true }] } };
    expect(sourceOptions('{a}.pdf', empty).map((o) => o.label)).toEqual([
      'Filename part: a',
      'The file name, without its extension',
      'The start of the document (a guess -- always flagged)',
    ]);
  });

  it('offers only sections that were actually found', () => {
    const labels = sourceOptions('{a}.pdf', scan).map((o) => o.label);
    expect(labels).toContain('Section: Abstract');
    expect(labels).not.toContain('Section: Summary');
  });

  it('ignores an invalid pattern instead of throwing', () => {
    expect(() => sourceOptions('{a}_{a}.pdf', scan)).not.toThrow();
  });
});

describe('describeSource', () => {
  it('names each kind of source in plain language', () => {
    expect(describeSource({ placeholder: 'last' })).toBe('Filename part: last');
    expect(describeSource({ join: '{last}, {first}' })).toBe('Filename parts joined as "{last}, {first}"');
    expect(describeSource({ label: 'Performer' })).toBe('Label in document: Performer');
    expect(describeSource({ property: 'title' })).toBe('Document property: title');
    expect(describeSource({ filename: true })).toBe('The file itself');
    expect(describeSource({ tableColumn: 'Job Description' })).toBe('Table column: Job Description');
    expect(describeSource({ section: 'Abstract' })).toBe('Section: Abstract');
  });
});
