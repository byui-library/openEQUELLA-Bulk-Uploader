// tests/desktop/ui/extract/sources.test.ts
import { describe, it, expect } from 'vitest';
import { sourceOptions, describeSource, restOfChain, optionsForColumn } from '../../../../src/desktop/ui/extract/sources.js';
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
  it('offers nothing from an empty scan except the placeholders and the sources that need no evidence', () => {
    const empty = { supported: [], skipped: [], labels: [], properties: [], tableColumns: [], sections: [], starter: { version: 1 as const, pattern: '{part1}.pdf', columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true as const }], locked: true }] } };
    expect(sourceOptions('{a}.pdf', empty).map((o) => o.label)).toEqual([
      'Filename part: a',
      'The file name, without its extension',
      'The start of the document (a guess -- always flagged)',
      'A language model, asked after extraction (only where no source was sure)',
    ]);
  });

  /**
   * ## The model belongs in the dropdown
   *
   * Turning it on for a column otherwise means hand-editing JSON, which is the
   * complaint the profile-editor work exists to answer. It is offered without
   * evidence-gating for the same reason the opening is: there is nothing to
   * find in a document that would make a model more or less available.
   *
   * The label must be `describeSource`'s, because the screen marks the current
   * option by comparing the two strings -- a hand-written label here renders a
   * dropdown that never shows what the column is already set to.
   */
  it('offers a language model, labelled the same way the column list describes one', () => {
    const model = sourceOptions('{a}.pdf', scan).find((o) => 'ai' in o.source);
    expect(model?.source).toEqual({ ai: true });
    expect(model?.label).toBe(describeSource({ ai: true }));
  });
});

/**
 * ## What the one dropdown does not govern
 *
 * Until the chain has its own editor, the dropdown sets element 0 and leaves
 * the rest. That is only honest if the row says what the rest is -- otherwise
 * an operator reads "Compose" and cannot tell that a language model runs after
 * it. Stage 2 of the design replaces this with an ordered editor; the wording
 * here deliberately promises no expansion that does not exist yet.
 */
describe('restOfChain', () => {
  it('says nothing for a column with one source', () => {
    expect(restOfChain([{ compose: '{birth_date}' }])).toBeNull();
  });

  it('says nothing for a column with no sources', () => {
    expect(restOfChain([])).toBeNull();
  });

  it('names what runs after the first source, in order', () => {
    expect(restOfChain([{ compose: '{x}' }, { ai: true }])).toBe(
      'then: A language model, asked after extraction (only where no source was sure)',
    );
  });

  it('names every later source, in order', () => {
    expect(restOfChain([{ compose: '{x}' }, { section: 'Abstract' }, { opening: true }])).toBe(
      'then: Section: Abstract, then: The start of the document (a guess -- always flagged)',
    );
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

/**
 * ## A configured column must not read as an empty one
 *
 * REPORTED BY THE OPERATOR: "the dropdowns all show (nothing - fill in Excel)
 * while there still appears to be something else that was selected."
 *
 * The `<select>` marks an option selected by comparing labels, and
 * `sourceOptions` offers only what the FILES supply -- placeholders, labels and
 * sections actually found, plus the three that need no evidence. The shipped
 * obituary template's first sources are `join`, `dateNear`, `presence` and
 * `compose`, and not one of them is on that list. Nothing matched, so every
 * configured column fell back to the first entry and reported itself as empty.
 *
 * Dangerous rather than merely untidy: a column that reads as unconfigured
 * invites somebody to configure it, and the shipped template's real sources are
 * one click from being replaced.
 */
describe('optionsForColumn', () => {
  const shown = (opts: { label: string }[]) => opts.map((o) => o.label);

  it('offers the current source when the files do not supply it', () => {
    const opts = optionsForColumn('{a}.pdf', scan, [{ dateNear: ['died'] }]);
    expect(shown(opts)).toContain('A date after: died');
  });

  /** Appended, so every index already handed out keeps meaning what it did. */
  it('leaves the offered options where they were', () => {
    const base = sourceOptions('{a}.pdf', scan);
    const opts = optionsForColumn('{a}.pdf', scan, [{ compose: '{x}' }]);
    expect(shown(opts).slice(0, base.length)).toEqual(shown(base));
  });

  it('does not repeat a source the files already supply', () => {
    const opts = optionsForColumn('{a}.pdf', scan, [{ section: 'Abstract' }]);
    expect(shown(opts).filter((l) => l === 'Section: Abstract')).toHaveLength(1);
  });

  it('adds nothing for a column with no sources', () => {
    expect(shown(optionsForColumn('{a}.pdf', scan, []))).toEqual(shown(sourceOptions('{a}.pdf', scan)));
  });

  /** Only the FIRST source is what the dropdown governs; the rest are named
   *  beside it by `restOfChain` and must not become options. */
  it('offers only the first of a chain', () => {
    const opts = optionsForColumn('{a}.pdf', scan, [{ compose: '{x}' }, { presence: { any: ['x'], then: 'y' } }]);
    expect(shown(opts)).toContain('Built from other columns: {x}');
    expect(shown(opts).some((l) => l.startsWith('"y" when'))).toBe(false);
  });
});
