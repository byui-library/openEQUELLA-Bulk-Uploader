// tests/extract/suggest.test.ts
import { describe, it, expect } from 'vitest';
import { detectPattern, starterProfile, matchSchemaPath } from '../../src/core/extract/suggest.js';
import { ATTACHMENT_COLUMN } from '../../src/core/extract/types.js';

describe('detectPattern', () => {
  it('detects underscore-separated parts', () => {
    expect(detectPattern(['Smith_Jane_Recital.pdf', 'Lee_Anna_Jury.pdf'])).toBe('{part1}_{part2}_{part3}.pdf');
  });

  it('detects hyphen-separated parts', () => {
    expect(detectPattern(['a-b-c.pdf', 'd-e-f.pdf'])).toBe('{part1}-{part2}-{part3}.pdf');
  });

  it('prefers the separator that gives a consistent part count', () => {
    expect(detectPattern(['a-1_b.pdf', 'c-2_d.pdf'])).toBe('{part1}_{part2}.pdf');
  });

  it('falls back to a single placeholder when parts are inconsistent', () => {
    expect(detectPattern(['a_b.pdf', 'c_d_e.pdf', 'f.pdf'])).toBe('{part1}.pdf');
  });

  it('uses the extension the files actually have', () => {
    expect(detectPattern(['a_b.docx'])).toBe('{part1}_{part2}.docx');
  });

  it('falls back to .pdf when given nothing', () => {
    expect(detectPattern([])).toBe('{part1}.pdf');
  });

  it('ignores files whose extension differs from the majority', () => {
    expect(detectPattern(['a_b.pdf', 'c_d.pdf', 'notes.txt'])).toBe('{part1}_{part2}.pdf');
  });

  // Only readable files may vote on the pattern. A real folder contains the
  // profile .json itself, Thumbs.db, stray notes -- and when unreadable files
  // were counted, a single .json alongside a single .pdf won the tie and
  // produced "{part1}.json". Found by the CLI's --init-profile test.
  it('ignores unreadable files even when they outnumber the readable ones', () => {
    expect(detectPattern(['Recital.pdf', 'p.profile.json'])).toBe('{part1}.pdf');
    expect(detectPattern(['a_b.pdf', 'x.json', 'y.json', 'Thumbs.db'])).toBe('{part1}_{part2}.pdf');
  });
});

describe('starterProfile', () => {
  it('always starts with the locked attachment column', () => {
    const profile = starterProfile(['Smith_Jane_Recital.pdf']);
    expect(profile.columns[0]).toEqual({
      path: ATTACHMENT_COLUMN,
      sources: [{ filename: true }],
      locked: true,
    });
  });

  it('proposes the three fields almost every item needs', () => {
    const profile = starterProfile(['Smith_Jane_Recital.pdf']);
    expect(profile.columns.map((c) => c.path)).toEqual([
      ATTACHMENT_COLUMN,
      'MWDL/title',
      'MWDL/creators/creator',
      'MWDL/description',
    ]);
    expect(profile.pattern).toBe('{part1}_{part2}_{part3}.pdf');
  });

  // Reading a title out of a document's own Title property is not a guess --
  // the document says so. Reading it out of filename part 2 would be, which is
  // why no filename part is wired up here.
  it('wires title and creator to the document properties that state them', () => {
    const columns = starterProfile(['a.pdf']).columns;
    expect(columns.find((c) => c.path === 'MWDL/title')?.sources).toEqual([
      { property: 'title' },
      // The filename is a poor title but a real one, and this field becomes the
      // item's name. Two of twelve real journal PDFs state no title at all.
      { filenameStem: true },
    ]);
    expect(columns.find((c) => c.path === 'MWDL/creators/creator')?.sources).toEqual([
      { property: 'author' },
    ]);
  });

  // Description is offered as an empty column on purpose. No document property
  // means "description" unambiguously -- PDF's /Subject is close but not the
  // same thing -- and inventing one would put a wrong value somewhere nobody
  // would think to check.
  it('leaves description empty, as a column to fill in by hand', () => {
    const description = starterProfile(['a.pdf']).columns.find((c) => c.path === 'MWDL/description');
    expect(description?.sources).toEqual([]);
    expect(description?.default).toBeUndefined();
  });

  it('proposes nothing that is not a real schema path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { extractDefinition, parseSchemaPaths } = await import('../../src/core/schema.js');
    const paths = parseSchemaPaths(extractDefinition(await readFile('schema/_entity.xml', 'utf8')));
    for (const column of starterProfile(['a.pdf']).columns) {
      if (column.path === ATTACHMENT_COLUMN) continue;
      expect(paths.has(column.path), `${column.path} is not in the schema`).toBe(true);
    }
  });

  it('is a valid profile', async () => {
    const { parseProfile } = await import('../../src/core/extract/profile.js');
    expect(() => parseProfile(starterProfile(['a_b.pdf']))).not.toThrow();
  });
});

describe('matchSchemaPath', () => {
  const paths = new Set([
    'MWDL/title',
    'MWDL/description',
    'MWDL/date',
    'MWDL/rights/description',
    'BYUI_extended/byui_rights/textbook/title',
  ]);

  // A Word table's headers are written for people: "Job Title", not
  // "MWDL/title". Matching the LAST WORD against the schema's leaf name reads
  // those without guessing at meaning.
  it('matches the last word of a phrase to a schema leaf', () => {
    expect(matchSchemaPath('Job Title', paths)).toBe('MWDL/title');
    expect(matchSchemaPath('Job Description', paths)).toBe('MWDL/description');
    expect(matchSchemaPath('Date', paths)).toBe('MWDL/date');
  });

  it('prefers MWDL where several fields share a leaf name', () => {
    // Both MWDL/description and MWDL/rights/description end in "description".
    // MWDL's own field is the one nearly every item needs.
    expect(matchSchemaPath('Description', paths)).toBe('MWDL/description');
    expect(matchSchemaPath('Title', paths)).toBe('MWDL/title');
  });

  it('returns null rather than guessing at a header with no counterpart', () => {
    expect(matchSchemaPath('Company', paths)).toBeNull();
    expect(matchSchemaPath('Qualifications', paths)).toBeNull();
    expect(matchSchemaPath('Pay', paths)).toBeNull();
    expect(matchSchemaPath('', paths)).toBeNull();
  });

  it('ignores case and surrounding space', () => {
    expect(matchSchemaPath('  job  TITLE  ', paths)).toBe('MWDL/title');
  });
});

describe('starterProfile with evidence from the documents', () => {
  const schemaPaths = new Set(['MWDL/title', 'MWDL/description', 'MWDL/date', 'MWDL/creators/creator']);

  it('maps a table column whose name matches a schema field', () => {
    const profile = starterProfile(['a.docx'], {
      labels: [],
      properties: [],
      tableColumns: ['Company', 'Job Title', 'Job Description', 'Pay'],
      sections: [],
      schemaPaths,
    });
    const title = profile.columns.find((c) => c.path === 'MWDL/title');
    const description = profile.columns.find((c) => c.path === 'MWDL/description');
    // Prepended, not replacing: a mixed folder needs the table for Word files
    // and the document property for PDFs.
    expect(title?.sources).toEqual([
      { tableColumn: 'Job Title' },
      { property: 'title' },
      { filenameStem: true },
    ]);
    expect(description?.sources).toEqual([{ tableColumn: 'Job Description' }, { opening: true }]);
  });

  it('does not invent a column for a header with no schema counterpart', () => {
    const profile = starterProfile(['a.docx'], {
      labels: [],
      properties: [],
      tableColumns: ['Company', 'Pay'],
      sections: [],
      schemaPaths,
    });
    expect(profile.columns.map((c) => c.path)).not.toContain('Company');
    expect(profile.columns.map((c) => c.path)).not.toContain('Pay');
  });

  // Labels are NOT auto-mapped: a table header is a stated field, a label
  // match is prose that looked like one. On real documents that produced a
  // Citation line in an academic paper becoming a column nobody wanted.
  it('does not auto-map a document label, only a table column', () => {
    const profile = starterProfile(['a.pdf'], {
      labels: ['Description'],
      properties: [],
      tableColumns: [],
      sections: [],
      schemaPaths,
    });
    // The opening fallback is there, but nothing was mapped from the label.
    expect(profile.columns.find((c) => c.path === 'MWDL/description')?.sources).toEqual([
      { opening: true },
    ]);
  });

  it('maps the table column even when a label of the same name exists', () => {
    const profile = starterProfile(['a.docx'], {
      labels: ['Title'],
      properties: [],
      tableColumns: ['Job Title'],
      sections: [],
      schemaPaths,
    });
    expect(profile.columns.find((c) => c.path === 'MWDL/title')?.sources[0]).toEqual({
      tableColumn: 'Job Title',
    });
  });

  it('keeps the document-property defaults when no evidence matches', () => {
    const profile = starterProfile(['a.pdf'], {
      labels: [],
      properties: ['title', 'author'],
      tableColumns: [],
      sections: [],
      schemaPaths,
    });
    expect(profile.columns.find((c) => c.path === 'MWDL/title')?.sources).toEqual([
      { property: 'title' },
      { filenameStem: true },
    ]);
    expect(profile.columns.find((c) => c.path === 'MWDL/creators/creator')?.sources).toEqual([
      { property: 'author' },
    ]);
  });

  it('behaves as before when given no evidence at all', () => {
    const profile = starterProfile(['a.pdf']);
    expect(profile.columns.map((c) => c.path)).toEqual([
      ATTACHMENT_COLUMN,
      'MWDL/title',
      'MWDL/creators/creator',
      'MWDL/description',
    ]);
  });
});

/**
 * Why only the description gets a section: a section is a body of prose, which
 * is what a description is and what no other field in this schema is. The
 * twelve journal PDFs in the operator's own folder produced an empty
 * description on every row of every run until this existed.
 */
describe('starterProfile proposing a section as the description', () => {
  const schemaPaths = new Set(['MWDL/title', 'MWDL/description', 'MWDL/creators/creator']);
  const nothing = { labels: [], properties: [], tableColumns: [], schemaPaths };

  function descriptionOf(sections: string[], tableColumns: string[] = []) {
    const profile = starterProfile(['a.pdf'], { ...nothing, tableColumns, sections });
    return profile.columns.find((c) => c.path === 'MWDL/description')?.sources;
  }

  it('proposes a found section', () => {
    expect(descriptionOf(['Abstract'])).toEqual([{ section: 'Abstract' }, { opening: true }]);
  });

  it('puts the section AFTER a stated field, never before it', () => {
    // A table cell headed "Job Description" is what the document says the
    // description is. An abstract is where a description usually lives. The
    // stated field wins; the section fills the rows it left blank.
    expect(descriptionOf(['Abstract'], ['Job Description'])).toEqual([
      { tableColumn: 'Job Description' },
      { section: 'Abstract' },
      { opening: true },
    ]);
  });

  it('proposes every found section, most description-like first', () => {
    // One profile serves the whole folder. Eleven of the operator's PDFs have
    // an Abstract and the twelfth has only a Purpose; listing both fills all
    // twelve, because the first source with anything in it wins per file.
    expect(descriptionOf(['Purpose', 'Abstract'])).toEqual([
      { section: 'Abstract' },
      { section: 'Purpose' },
      { opening: true },
    ]);
  });

  /**
   * The last resort, and the reason the description column is never simply
   * empty any more. It sits behind every stated field and every named section,
   * so it only ever competes with a blank cell -- and it always arrives with a
   * note saying it was a guess.
   */
  it('falls back to the start of the document, behind everything else', () => {
    expect(descriptionOf(['Abstract'], ['Job Description'])).toEqual([
      { tableColumn: 'Job Description' },
      { section: 'Abstract' },
      { opening: true },
    ]);
  });

  it('offers the start of the document even when nothing else was found', () => {
    expect(descriptionOf([])).toEqual([{ opening: true }]);
  });

  it('proposes the opening for no other column', () => {
    const profile = starterProfile(['a.pdf'], { ...nothing, sections: ['Abstract'] });
    for (const column of profile.columns) {
      if (column.path === 'MWDL/description') continue;
      expect(column.sources).not.toContainEqual({ opening: true });
    }
  });

  it('proposes a section for no other column', () => {
    const profile = starterProfile(['a.pdf'], { ...nothing, sections: ['Abstract'] });
    for (const column of profile.columns) {
      if (column.path === 'MWDL/description') continue;
      expect(column.sources).not.toContainEqual({ section: 'Abstract' });
    }
  });
});

describe('starterProfile falling back to the filename for a title', () => {
  it('offers it last, behind the document property', () => {
    expect(starterProfile(['a.pdf']).columns.find((c) => c.path === 'MWDL/title')?.sources).toEqual([
      { property: 'title' },
      { filenameStem: true },
    ]);
  });

  // The CLI's --init-profile passes no evidence, so it gets none of the
  // scan-driven fallbacks. This one needs no evidence -- every file has a name.
  it('offers it whether or not a scan found anything', () => {
    const scanned = starterProfile(['a.docx'], {
      labels: [],
      properties: [],
      tableColumns: ['Job Title'],
      sections: [],
      schemaPaths: new Set(['MWDL/title']),
    });
    expect(scanned.columns.find((c) => c.path === 'MWDL/title')?.sources).toEqual([
      { tableColumn: 'Job Title' },
      { property: 'title' },
      { filenameStem: true },
    ]);
  });

  it('proposes it for no other column', () => {
    for (const column of starterProfile(['a.pdf']).columns) {
      if (column.path === 'MWDL/title') continue;
      expect(column.sources).not.toContainEqual({ filenameStem: true });
    }
  });
});
