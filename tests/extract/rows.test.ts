// tests/extract/rows.test.ts
import { describe, it, expect } from 'vitest';
import { buildRow, normaliseDate, normaliseDateWithFormat, splitPeople } from '../../src/core/extract/rows.js';
import { ATTACHMENT_COLUMN, type DocumentData, type Profile } from '../../src/core/extract/types.js';

const EMPTY_DOC: DocumentData = { text: '', hasTextLayer: true, properties: {}, tables: [] };

const profile: Profile = {
  version: 1,
  pattern: '{last}_{first}_{title}_{date}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }, { label: 'Title' }] },
    { path: 'MWDL/creators/creator', sources: [{ join: '{last}, {first}' }, { label: 'Performer' }] },
    { path: 'MWDL/date', sources: [{ placeholder: 'date' }, { property: 'created' }], transform: 'date' },
    { path: 'MWDL/publisher', sources: [], default: 'BYU-Idaho' },
    { path: 'MWDL/description', sources: [] },
  ],
};

describe('normaliseDate', () => {
  it('passes an ISO date through', () => {
    expect(normaliseDate('2026-04-12')).toBe('2026-04-12');
  });

  it('normalises a long form date', () => {
    expect(normaliseDate('April 12, 2026')).toBe('2026-04-12');
  });

  it('returns null for something that is not a date', () => {
    expect(normaliseDate('Recital_2026')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(normaliseDate('')).toBeNull();
  });

  // The bare-year guard. V8 parses new Date('1953') successfully, to
  // 1953-01-01 -- inventing a month and a day that were never in the source.
  // Year-only dates are ordinary in digitised material, so this is not an
  // edge case. A mutation pass found that deleting both guard lines broke no
  // test, because the existing "not a date" inputs are rejected by V8 anyway.
  it('returns null for a bare year rather than inventing January the 1st', () => {
    expect(normaliseDate('1953')).toBeNull();
    expect(normaliseDate('2026')).toBeNull();
  });

  // Word writes `created` as a UTC timestamp. Reading local date parts off it
  // shifted the day backwards for any time before the UTC offset -- a silently
  // wrong date, with no note, on a published item. Found by running against 59
  // real .docx files. The date part of an ISO timestamp is taken verbatim now;
  // no Date parsing, so no timezone can be involved.
  it('takes the date from an ISO timestamp without shifting the day', () => {
    expect(normaliseDate('2025-12-04T01:00:00Z')).toBe('2025-12-04');
    expect(normaliseDate('2025-06-04T02:30:00Z')).toBe('2025-06-04');
    expect(normaliseDate('2025-12-03T23:58:00Z')).toBe('2025-12-03');
  });

  it('takes the date from an ISO timestamp with a non-UTC offset', () => {
    expect(normaliseDate('2025-12-04T01:00:00+13:00')).toBe('2025-12-04');
  });

  it('returns null for a value with no four-digit year at all', () => {
    expect(normaliseDate('April')).toBeNull();
    expect(normaliseDate('12/04')).toBeNull();
  });
});

describe('normaliseDateWithFormat', () => {
  // A compact date is genuinely ambiguous -- 12032025 is 3 December to one
  // reader and 12 March to another -- so the tool never guesses it. The
  // profile declares which it is, because the operator knows and the file
  // does not say. Found by running against 59 real files whose convention is
  // MMDDYYYY; every row was flagged until the format could be stated.
  it('parses a compact date in the declared order', () => {
    expect(normaliseDateWithFormat('12032025', 'MMDDYYYY')).toBe('2025-12-03');
    expect(normaliseDateWithFormat('12032025', 'DDMMYYYY')).toBe('2025-03-12');
    expect(normaliseDateWithFormat('20251203', 'YYYYMMDD')).toBe('2025-12-03');
  });

  it('parses a date with separators', () => {
    expect(normaliseDateWithFormat('12/03/2025', 'MM/DD/YYYY')).toBe('2025-12-03');
    expect(normaliseDateWithFormat('03-12-2025', 'DD-MM-YYYY')).toBe('2025-12-03');
  });

  it('returns null when the value does not match the declared format', () => {
    expect(normaliseDateWithFormat('2025-12-03', 'MMDDYYYY')).toBeNull();
    expect(normaliseDateWithFormat('120325', 'MMDDYYYY')).toBeNull();
    expect(normaliseDateWithFormat('', 'MMDDYYYY')).toBeNull();
  });

  it('rejects a value that matches the shape but is not a real date', () => {
    expect(normaliseDateWithFormat('13012025', 'MMDDYYYY')).toBeNull();
    expect(normaliseDateWithFormat('02302025', 'MMDDYYYY')).toBeNull();
    expect(normaliseDateWithFormat('00012025', 'MMDDYYYY')).toBeNull();
  });

  it('accepts a real leap day and rejects a false one', () => {
    expect(normaliseDateWithFormat('02292024', 'MMDDYYYY')).toBe('2024-02-29');
    expect(normaliseDateWithFormat('02292025', 'MMDDYYYY')).toBeNull();
  });

  it('treats separator characters literally, not as regex', () => {
    expect(normaliseDateWithFormat('12.03.2025', 'MM.DD.YYYY')).toBe('2025-12-03');
    expect(normaliseDateWithFormat('12x03x2025', 'MM.DD.YYYY')).toBeNull();
  });
});

describe('buildRow', () => {
  it('fills the attachment column with the filename verbatim', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells[ATTACHMENT_COLUMN]).toBe('Smith_Jane_Recital_2026-04-12.pdf');
  });

  it('takes the first non-empty source and does not overwrite it', () => {
    const doc: DocumentData = { ...EMPTY_DOC, text: 'Title: A Different Title\n' };
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', doc);
    expect(row.cells['MWDL/title']).toBe('Recital');
    expect(row.sources['MWDL/title']).toBe('filename');
  });

  it('falls through to a later source when an earlier one is empty', () => {
    const doc: DocumentData = { ...EMPTY_DOC, text: 'Performer: Anna Lee\n' };
    const row = buildRow({ ...profile, pattern: '{title}.pdf' }, 'Recital.pdf', doc);
    expect(row.cells['MWDL/creators/creator']).toBe('Anna Lee');
    expect(row.sources['MWDL/creators/creator']).toBe('label');
  });

  it('joins placeholders', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/creators/creator']).toBe('Smith, Jane');
  });

  it('applies a default when every source was empty', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/publisher']).toBe('BYU-Idaho');
    expect(row.sources['MWDL/publisher']).toBe('default');
  });

  it('leaves a column with no source and no default empty, without a note', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/description']).toBe('');
    expect(row.notes.join(' ')).not.toContain('description');
  });

  it('normalises a date', () => {
    const doc: DocumentData = { ...EMPTY_DOC, properties: { created: 'April 12, 2026' } };
    const row = buildRow({ ...profile, pattern: '{title}.pdf' }, 'Recital.pdf', doc);
    expect(row.cells['MWDL/date']).toBe('2026-04-12');
  });

  // Exactly four underscore-separated tokens, matching the four placeholders.
  // A fifth token would be absorbed by {date} through the lazy matching that
  // pattern.ts documents and tests, giving 'Recital_x' rather than 'x'.
  it('keeps an unrecognisable date verbatim and says so', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_x.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/date']).toBe('x');
    expect(row.notes.join(' ')).toMatch(/not recognised as a date/i);
  });

  // The same guard as above, but reached the way a real batch would reach it:
  // through a filename whose date part is just a year. The cell must keep the
  // year as found and say so, not silently become the first of January.
  it('keeps a year-only date verbatim instead of inventing a month and day', () => {
    const row = buildRow({ ...profile, pattern: '{title}_{date}.pdf' }, 'Recital_1953.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/date']).toBe('1953');
    expect(row.notes.join(' ')).toMatch(/not recognised as a date/i);
  });

  // The declared format reaching a row the way a real batch does.
  it('uses a declared date format from the column', () => {
    const withFormat: Profile = {
      ...profile,
      pattern: '{title}_{date}.pdf',
      columns: profile.columns.map((c) =>
        c.path === 'MWDL/date' ? { ...c, transform: { date: 'MMDDYYYY' } as const } : c,
      ),
    };
    const row = buildRow(withFormat, 'Recital_12032025.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/date']).toBe('2025-12-03');
    expect(row.notes).toEqual([]);
  });

  it('notes when a value does not match the declared date format', () => {
    const withFormat: Profile = {
      ...profile,
      pattern: '{title}_{date}.pdf',
      columns: profile.columns.map((c) =>
        c.path === 'MWDL/date' ? { ...c, transform: { date: 'MMDDYYYY' } as const } : c,
      ),
    };
    const row = buildRow(withFormat, 'Recital_2025-12-03.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/date']).toBe('2025-12-03');
    expect(row.notes.join(' ')).toMatch(/not recognised as a date/i);
  });

  // Word documents here hold their metadata as a table: a header row naming the
  // fields, then one row of values. This reads a named field out of that.
  it('reads a value from the table column with that header', () => {
    const doc: DocumentData = {
      ...EMPTY_DOC,
      tables: [
        {
          headers: ['Company', 'Job Title', 'Date'],
          rows: [['Banner Health', 'Associate Director', '06/05/2026']],
        },
      ],
    };
    const withTable: Profile = {
      ...profile,
      pattern: '{title}.docx',
      columns: [
        profile.columns[0]!,
        { path: 'MWDL/title', sources: [{ tableColumn: 'Job Title' }] },
        { path: 'MWDL/publisher', sources: [{ tableColumn: 'Company' }] },
      ],
    };
    const row = buildRow(withTable, 'x.docx', doc);
    expect(row.cells['MWDL/title']).toBe('Associate Director');
    expect(row.cells['MWDL/publisher']).toBe('Banner Health');
    expect(row.sources['MWDL/title']).toBe('table');
  });

  it('falls through when the table has no column with that header', () => {
    const doc: DocumentData = {
      ...EMPTY_DOC,
      text: 'Title: From a label\n',
      tables: [{ headers: ['Company'], rows: [['Banner Health']] }],
    };
    const withTable: Profile = {
      ...profile,
      pattern: '{x}.docx',
      columns: [
        profile.columns[0]!,
        { path: 'MWDL/title', sources: [{ tableColumn: 'Nope' }, { label: 'Title' }] },
      ],
    };
    expect(buildRow(withTable, 'a.docx', doc).cells['MWDL/title']).toBe('From a label');
  });

  it('gives nothing for a table that has headers but no data row', () => {
    const doc: DocumentData = { ...EMPTY_DOC, tables: [{ headers: ['Company'], rows: [] }] };
    const withTable: Profile = {
      ...profile,
      pattern: '{x}.docx',
      columns: [profile.columns[0]!, { path: 'MWDL/title', sources: [{ tableColumn: 'Company' }] }],
    };
    expect(buildRow(withTable, 'a.docx', doc).cells['MWDL/title']).toBe('');
  });

  it('matches a header ignoring case and surrounding space', () => {
    const doc: DocumentData = {
      ...EMPTY_DOC,
      tables: [{ headers: ['  Job Title  '], rows: [['Associate Director']] }],
    };
    const withTable: Profile = {
      ...profile,
      pattern: '{x}.docx',
      columns: [profile.columns[0]!, { path: 'MWDL/title', sources: [{ tableColumn: 'job title' }] }],
    };
    expect(buildRow(withTable, 'a.docx', doc).cells['MWDL/title']).toBe('Associate Director');
  });

  it('notes when the filename does not match the pattern, and still returns a row', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(row.cells[ATTACHMENT_COLUMN]).toBe('unmatched.pdf');
    expect(row.cells['MWDL/title']).toBe('');
    expect(row.notes.join(' ')).toMatch(/does not match the pattern/i);
  });

  it('notes a missing text layer', () => {
    const doc: DocumentData = { ...EMPTY_DOC, hasTextLayer: false };
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', doc);
    expect(row.notes.join(' ')).toMatch(/no text layer/i);
  });

  it('includes every profile column, even the empty ones', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(Object.keys(row.cells)).toEqual(profile.columns.map((c) => c.path));
  });

  it('records sources only for columns that got a value', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(row.sources['MWDL/title']).toBeUndefined();
    expect(row.sources[ATTACHMENT_COLUMN]).toBe('filename');
  });
});

describe('splitPeople', () => {
  // Comma means two different things in real author strings: "Dixon, Matt" is
  // one person written surname-first, "Dan Weaving, Ben Jones" is two people.
  // So a split happens only where the string cannot be one name.
  it('splits when the string contains " and "', () => {
    expect(splitPeople('Sergio J. Ibáñez, Markel Rico-González and José Pino-Ortega')).toEqual({
      value: 'Sergio J. Ibáñez; Markel Rico-González; José Pino-Ortega',
      ambiguous: false,
    });
  });

  it('splits when there are three or more comma-separated parts', () => {
    expect(splitPeople('Dan Weaving, Ben Jones, Matt Ireton').value).toBe(
      'Dan Weaving; Ben Jones; Matt Ireton',
    );
  });

  it('leaves a two-part string alone and says it is ambiguous', () => {
    expect(splitPeople('Dixon, Matt')).toEqual({ value: 'Dixon, Matt', ambiguous: true });
  });

  it('leaves a single name alone and is not ambiguous about it', () => {
    expect(splitPeople('Xiangyu Ren')).toEqual({ value: 'Xiangyu Ren', ambiguous: false });
  });

  it('handles an empty value', () => {
    expect(splitPeople('')).toEqual({ value: '', ambiguous: false });
  });

  it('does not double-split a string that already uses semicolons', () => {
    expect(splitPeople('A; B; C')).toEqual({ value: 'A; B; C', ambiguous: false });
  });

  it('drops the Oxford comma before "and" rather than leaving an empty author', () => {
    expect(splitPeople('A, B, and C').value).toBe('A; B; C');
  });
});

describe('buildRow with the people transform', () => {
  it('separates authors and notes the ones it would not guess at', () => {
    const withPeople: Profile = {
      ...profile,
      pattern: '{x}.pdf',
      columns: [
        profile.columns[0]!,
        { path: 'MWDL/creators/creator', sources: [{ property: 'author' }], transform: 'people' },
      ],
    };
    const many: DocumentData = {
      ...EMPTY_DOC,
      properties: { author: 'Dan Weaving, Ben Jones, Matt Ireton' },
    };
    expect(buildRow(withPeople, 'a.pdf', many).cells['MWDL/creators/creator']).toBe(
      'Dan Weaving; Ben Jones; Matt Ireton',
    );

    const one: DocumentData = { ...EMPTY_DOC, properties: { author: 'Dixon, Matt' } };
    const row = buildRow(withPeople, 'a.pdf', one);
    expect(row.cells['MWDL/creators/creator']).toBe('Dixon, Matt');
    expect(row.notes.join(' ')).toMatch(/one name or two/i);
  });
});

describe('buildRow reading a section', () => {
  const withSection = (text: string): DocumentData => ({
    text,
    hasTextLayer: true,
    properties: {},
    tables: [],
  });

  const sectionProfile: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/description', sources: [{ section: 'Abstract' }] },
    ],
  };

  it('takes the text under the heading', () => {
    const row = buildRow(
      sectionProfile,
      'a.pdf',
      withSection('Abstract A study of jumping. Keywords sport'),
    );
    expect(row.cells['MWDL/description']).toBe('A study of jumping.');
    expect(row.sources['MWDL/description']).toBe('section');
    expect(row.notes).toEqual([]);
  });

  /**
   * A section that ran to the length cap never reached another heading, which
   * on real files means the heading was not one: a benefits PDF matched
   * "Summary" mid-page and produced 3,996 characters of plan tables. The value
   * is kept -- it may still be useful -- but it is never kept silently.
   */
  it('flags a section that ran to the cap', () => {
    const row = buildRow(sectionProfile, 'a.pdf', withSection(`Abstract ${'word '.repeat(3000)}`));
    expect(row.cells['MWDL/description']?.length).toBeGreaterThan(100);
    expect(row.notes.join(' ')).toMatch(/Abstract/);
    expect(row.notes.join(' ')).toMatch(/cut short|too long|never ended/i);
  });
});

describe('buildRow and the filename pattern', () => {
  const doc: DocumentData = {
    text: 'Abstract A study of jumping. Keywords sport',
    hasTextLayer: true,
    properties: {},
    tables: [],
  };

  /**
   * A mixed folder gets one pattern, and it can only carry one extension. A
   * folder of 18 Word files and 12 PDFs produced `{part1}_{part2}_{part3}.docx`
   * and then flagged every PDF row for not matching it -- twelve warnings about
   * something no column was reading. The warning is worth making only when a
   * column actually needs a piece of the filename.
   */
  it('says nothing about a filename that matches no pattern when no column uses one', () => {
    const noParts: Profile = {
      version: 1,
      pattern: '{a}_{b}_{c}.docx',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/description', sources: [{ section: 'Abstract' }] },
      ],
    };
    expect(buildRow(noParts, 'no-underscores-here.pdf', doc).notes).toEqual([]);
  });

  it('still warns when a column reads a placeholder', () => {
    const usesParts: Profile = {
      version: 1,
      pattern: '{a}_{b}_{c}.docx',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/title', sources: [{ placeholder: 'a' }] },
      ],
    };
    expect(buildRow(usesParts, 'no-underscores-here.pdf', doc).notes.join(' ')).toMatch(
      /does not match the pattern/,
    );
  });

  it('still warns when a column joins placeholders', () => {
    const usesJoin: Profile = {
      version: 1,
      pattern: '{a}_{b}_{c}.docx',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/creators/creator', sources: [{ join: '{b}, {a}' }] },
      ],
    };
    expect(buildRow(usesJoin, 'no-underscores-here.pdf', doc).notes.join(' ')).toMatch(
      /does not match the pattern/,
    );
  });
});

/**
 * Two of the operator's twelve journal PDFs carry no title property at all, so
 * `MWDL/title` came out empty -- and that field becomes the item's name in
 * openEQUELLA. Those two would have been contributed nameless. The filename is
 * not a good title, but it is a real one, and it is the only thing left.
 */
describe('buildRow reading the filename without its extension', () => {
  const stemProfile: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ property: 'title' }, { filenameStem: true }] },
    ],
  };

  it('drops the extension', () => {
    const row = buildRow(stemProfile, '07 - Accelerometry-Based Load (2019).pdf', EMPTY_DOC);
    expect(row.cells['MWDL/title']).toBe('07 - Accelerometry-Based Load (2019)');
    expect(row.sources['MWDL/title']).toBe('filename');
  });

  // The titles in this batch are full of dots: "22. Salazar_proof_10pix1line".
  it('drops only the last extension, not every dot', () => {
    expect(buildRow(stemProfile, '22. Salazar_proof.v2.pdf', EMPTY_DOC).cells['MWDL/title']).toBe(
      '22. Salazar_proof.v2',
    );
  });

  it('keeps a name that has no extension', () => {
    expect(buildRow(stemProfile, 'Recital', EMPTY_DOC).cells['MWDL/title']).toBe('Recital');
  });

  it('never overrides a title the document states', () => {
    const titled: DocumentData = { ...EMPTY_DOC, properties: { title: 'A Real Title' } };
    expect(buildRow(stemProfile, 'ugly_filename.pdf', titled).cells['MWDL/title']).toBe(
      'A Real Title',
    );
  });
});

describe('buildRow with templated sources', () => {
  const doc = (text: string): DocumentData => ({
    text,
    hasTextLayer: true,
    properties: {},
    tables: [],
  });

  const obitProfile: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      {
        path: 'MWDL/date',
        as: 'death',
        sources: [{ dateNear: ['passed away', 'died'] }, { datePair: 'second' }],
        transform: 'date',
      },
      { path: 'MWDL/description', sources: [{ compose: 'Died {death}' }] },
    ],
  };

  it('reads a death date from prose and normalises it', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('He passed away on January 4, 2024 at home.'));
    expect(row.cells['MWDL/date']).toBe('2024-01-04');
    expect(row.sources['MWDL/date']).toBe('dateNear');
  });

  it('falls back to the dash pair when no phrase appears', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('Eric Scott June 19, 1957 - January 6, 2024 Utah'));
    expect(row.cells['MWDL/date']).toBe('2024-01-06');
    expect(row.sources['MWDL/date']).toBe('datePair');
  });

  /**
   * The composed column must see the OTHER column's finished value, including
   * its transform -- not the raw text it was read from.
   */
  it('composes from the transformed value of another column', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('He died January 4, 2024.'));
    expect(row.cells['MWDL/description']).toBe('Died 2024-01-04');
    expect(row.sources['MWDL/description']).toBe('compose');
  });

  it('composes to nothing when the column it reads is empty', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('No date is stated anywhere in this document.'));
    expect(row.cells['MWDL/date']).toBe('');
    expect(row.cells['MWDL/description']).toBe('');
  });

  /**
   * An obituary almost always names a relative's death too. The first date is
   * taken, but the row must say so -- a silently wrong death date in a
   * permanent record is the worst thing this feature can produce.
   */
  it('flags a row where the phrases found more than one date', () => {
    const row = buildRow(
      obitProfile,
      'a.pdf',
      doc('Preceded in death by his wife Ruth, who passed away on March 2, 1998. He died January 4, 2024.'),
    );
    expect(row.cells['MWDL/date']).toBe('1998-03-02');
    expect(row.notes.join(' ')).toMatch(/more than one date/);
    expect(row.notes.join(' ')).toContain('January 4, 2024');
  });

  it('does not flag a row where only one date was found', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('He died January 4, 2024.'));
    expect(row.notes).toEqual([]);
  });

  // A composed column declared BEFORE the column it reads must still work:
  // the passes decide the order, not the position in the list.
  it('is not confused by column order', () => {
    const reversed: Profile = {
      ...obitProfile,
      columns: [obitProfile.columns[2]!, obitProfile.columns[1]!, obitProfile.columns[0]!],
    };
    expect(buildRow(reversed, 'a.pdf', doc('died January 4, 2024')).cells['MWDL/description']).toBe(
      'Died 2024-01-04',
    );
  });
});

describe('buildRow and flagIfEmpty', () => {
  const doc = (text: string): DocumentData => ({ text, hasTextLayer: true, properties: {}, tables: [] });
  const profile: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/date', sources: [{ dateNear: ['died'] }], flagIfEmpty: true },
    ],
  };

  it('flags the row when the column it had to find is empty', () => {
    expect(buildRow(profile, 'a.pdf', doc('no date here')).notes.join(' ')).toContain('MWDL/date');
  });

  /**
   * A note that only reports the absence invites someone to invent a value.
   * One real obituary states no date anywhere -- "the early hours of Saturday
   * morning" -- so a blank there is the CORRECT answer, and the note has to
   * say so or it reads as a defect to be fixed.
   */
  it('says a blank may be the right answer, not only that the cell is empty', () => {
    const note = buildRow(profile, 'a.pdf', doc('no date here')).notes.join(' ');
    expect(note).toMatch(/by hand/i);
    expect(note).toMatch(/leave it blank/i);
  });

  it('says nothing when the column was filled', () => {
    expect(buildRow(profile, 'a.pdf', doc('He died January 4, 2024')).notes).toEqual([]);
  });

  it('does not flag a column that did not ask to be flagged', () => {
    const quiet: Profile = {
      ...profile,
      columns: [profile.columns[0]!, { ...profile.columns[1]!, flagIfEmpty: undefined }],
    };
    expect(buildRow(quiet, 'a.pdf', doc('no date here')).notes).toEqual([]);
  });
});

describe('buildRow and the filename check', () => {
  const doc = (text: string): DocumentData => ({ text, hasTextLayer: true, properties: {}, tables: [] });
  const withCheck: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true }],
    checks: { filenameWordsInText: { ignore: ['Obituary'] } },
  };

  it('flags a filename word the document does not contain', () => {
    const row = buildRow(withCheck, 'Brandon Lythoe Obituary.pdf', doc('Brandon Lythgoe passed away'));
    expect(row.notes.join(' ')).toContain('Lythoe');
  });

  /**
   * The note has to say what to DO, not just what was noticed. The operator
   * asked for this after reading the first version, which reported the
   * mismatch and left them to work out that the filename might be the wrong
   * one -- and it is the filename that becomes the item's permanent title.
   */
  it('tells the operator to check the filename, and why it matters', () => {
    const note = buildRow(
      withCheck,
      'Brandon Lythoe Obituary.pdf',
      doc('Brandon Lythgoe passed away'),
    ).notes.join(' ');
    expect(note).toMatch(/check this filename/i);
    expect(note).toMatch(/title/i);
  });

  it('says nothing when every word appears', () => {
    const row = buildRow(withCheck, 'Clyde Williams Obituary.pdf', doc('Clyde L Williams was born'));
    expect(row.notes).toEqual([]);
  });

  it('does not run the check when the profile does not ask for it', () => {
    const noCheck: Profile = { ...withCheck, checks: undefined };
    expect(buildRow(noCheck, 'Brandon Lythoe.pdf', doc('Brandon Lythgoe')).notes).toEqual([]);
  });
});
