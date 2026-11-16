// tests/extract/sequenceChecks.test.ts
import { describe, it, expect } from 'vitest';
import {
  checkBatch,
  checkSequence,
  folderGroup,
  orderBySequence,
  parseParts,
  resolveLabels,
} from '../../src/core/extract/sequenceChecks.js';

const PATTERNS = ['V{group}_No{part}', 'V{group}_Num{part}'];
// The first serial's own words, so every message reads exactly as an operator sees it.
const LABELS = resolveLabels({ part: 'issue', group: 'volume' });
const RULE = { patterns: PATTERNS, labels: LABELS };

describe('parseParts', () => {
  it.each([
    ['3', [3]],
    ['2&3', [2, 3]],
    ['2 & 3', [2, 3]],
    ['1+2', [1, 2]],
    ['2-4', [2, 3, 4]],
    ['10', [10]],
  ])('reads %s as %j', (text, issues) => expect(parseParts(text)).toEqual(issues));

  it('does not read a year after a dash as the end of a range', () => {
    expect(parseParts('3-1974')).toEqual([3]);
  });
});

describe('folderGroup', () => {
  it("reads the folder's {group} from the profile pattern", () => {
    expect(folderGroup('Gazette_V{group}', 'Gazette_V12')).toBe(12);
  });
  it('is null when the folder name does not match, or the value is not a number', () => {
    expect(folderGroup('Gazette_V{group}', 'Extras')).toBeNull();
    expect(folderGroup('Gazette_V{group}', 'Gazette_VX')).toBeNull();
    expect(folderGroup('{name}', 'Gazette_V12')).toBeNull();
  });
});

describe('checkSequence', () => {
  it('finds nothing to say about a clean run', () => {
    const r = checkSequence(RULE, 4, 'Gazette_V4', ['G_1975_V4_No1.pdf', 'G_1975_V4_No2.pdf']);
    expect(r).toEqual({ findings: [], numbered: 2, years: null });
  });

  it('holds the folder back for a file named for another volume, and leaves it out of the other checks', () => {
    const r = checkSequence(RULE, 3, 'Gazette_V3', [
      'G_1973_V2_No4.pdf',
      'G_1973_V3_No1.pdf',
      'G_1974_V3_No2.pdf',
    ]);
    expect(r.findings).toEqual([
      {
        file: 'G_1973_V2_No4.pdf',
        effect: 'held back',
        problem: "its name says volume 2, but it is in the folder for volume 3 ('Gazette_V3')",
        fix:
          'move it into the folder for volume 2, then build the spreadsheet again -- or, if this ' +
          'folder is right, correct the file name',
      },
    ]);
  });

  it('holds the folder back when two files claim one issue, naming both', () => {
    const r = checkSequence(RULE, 3, 'Gazette_V3', [
      'G_1974_V3_No3.pdf',
      'G_1974_V3_No4.pdf',
      'G_1974_V3_Num3.pdf',
      'G_1974_V3_No1.pdf',
      'G_1974_V3_No2.pdf',
    ]);
    expect(r.findings).toEqual([
      {
        file: 'G_1974_V3_No3.pdf, G_1974_V3_Num3.pdf',
        effect: 'held back',
        problem: '2 files claim issue 3',
        fix: 'keep the right one, or rename the other so its issue number is correct, then build the spreadsheet again',
      },
    ]);
  });

  it('notes a file with no issue number, without holding the folder back', () => {
    const r = checkSequence(RULE, 27, 'Gazette_V27', [
      'G_1998_Commemorative.pdf',
      'G_1998_V27_No1.pdf',
      'G_1998_V27_No2.pdf',
    ]);
    expect(r.findings).toEqual([
      {
        file: 'G_1998_Commemorative.pdf',
        effect: 'note',
        problem: 'no issue number in its name; it is attached after the numbered issues',
        fix: 'nothing, if last is its place; otherwise rename it so a pattern finds its issue number',
      },
    ]);
  });

  it('notes a gap, saying a missing last issue cannot be seen', () => {
    const r = checkSequence(RULE, 5, 'Gazette_V5', ['G_V5_No1.pdf', 'G_V5_No2.pdf', 'G_V5_No4.pdf']);
    expect(r.findings).toEqual([
      {
        file: '',
        effect: 'note',
        problem:
          'issue 3 is missing from the numbering (issues 1 to 4 found); a missing LAST issue cannot be detected',
        fix: 'check whether it exists; if the volume is genuinely incomplete, nothing is needed',
      },
    ]);
  });

  it('notes the issues missing before the first one found', () => {
    const r = checkSequence(RULE, 5, 'Gazette_V5', ['G_V5_No3.pdf']);
    expect(r.findings[0]?.problem).toMatch(/^issues 1, 2 are missing/);
  });

  it('reads a combined issue as covering both numbers: no gap, no duplicate', () => {
    const r = checkSequence(RULE, 4, 'Gazette_V4', ['G_V4_No1.pdf', 'G_V4_No2&3.pdf', 'G_V4_No4.pdf']);
    expect(r.findings).toEqual([]);
  });

  it('matches anywhere in the name, ignoring case and a hyphenated year before it', () => {
    const r = checkSequence(RULE, 2, 'Gazette_V2', ['G_1972-73_v2_no3.pdf', 'G_1972_V2_No1.pdf', 'G_1972_V2_No2.pdf']);
    expect(r).toEqual({ findings: [], numbered: 3, years: null });
  });

  it('cannot compare volumes when the folder gives none, and says so once', () => {
    const r = checkSequence(RULE, null, 'Extras', ['G_V2_No1.pdf', 'G_V3_No2.pdf']);
    expect(r.findings).toEqual([
      {
        file: '',
        effect: 'note',
        problem: "the folder name 'Extras' gives no volume number, so its files were not checked against one",
        fix: "rename the folder to match the profile's pattern if it is a volume",
      },
    ]);
  });

  it('a pattern without {group} checks parts only', () => {
    const r = checkSequence({ patterns: ['No{part}'], labels: LABELS }, null, 'Anything', ['a_No1.pdf', 'b_No1.pdf']);
    expect(r.findings[0]).toMatchObject({ effect: 'held back', problem: '2 files claim issue 1' });
  });
});

describe('checkSequence -- a folder of one', () => {
  it('says nothing about an unnumbered file that is alone: there is no order for it to be wrong in', () => {
    expect(checkSequence(RULE, 17, 'Gazette_V17', ['G_1988_V17.pdf'])).toEqual({ findings: [], numbered: 0, years: null });
  });
});

describe('orderBySequence', () => {
  it('orders by issue number across a year boundary in the names', () => {
    expect(
      orderBySequence(PATTERNS, ['G_1972-73_V2_No3.pdf', 'G_1972_V2_No1.pdf', 'G_1972_V2_No2.pdf', 'G_1973_V2_No4.pdf']),
    ).toEqual(['G_1972_V2_No1.pdf', 'G_1972_V2_No2.pdf', 'G_1972-73_V2_No3.pdf', 'G_1973_V2_No4.pdf']);
  });

  it('puts files with no issue number last, keeping their name order', () => {
    expect(orderBySequence(PATTERNS, ['G_Commemorative.pdf', 'G_Index.pdf', 'G_V27_No2.pdf', 'G_V27_No1.pdf'])).toEqual([
      'G_V27_No1.pdf',
      'G_V27_No2.pdf',
      'G_Commemorative.pdf',
      'G_Index.pdf',
    ]);
  });

  it('places a combined issue by its lowest number', () => {
    expect(orderBySequence(PATTERNS, ['G_V4_No4.pdf', 'G_V4_No2&3.pdf', 'G_V4_No1.pdf'])).toEqual([
      'G_V4_No1.pdf',
      'G_V4_No2&3.pdf',
      'G_V4_No4.pdf',
    ]);
  });

  it('keeps the given order for a tie, and for no patterns at all', () => {
    expect(orderBySequence(PATTERNS, ['b_V1_No1.pdf', 'a_V1_No1.pdf'])).toEqual(['b_V1_No1.pdf', 'a_V1_No1.pdf']);
    expect(orderBySequence([], ['z.pdf', 'a.pdf'])).toEqual(['z.pdf', 'a.pdf']);
  });
});

describe('checkSequence -- dates', () => {
  const DATED = ['{year}_V{group}_No{part}'];

  it('accepts a volume that runs across a year boundary, in order', () => {
    const r = checkSequence({ patterns: DATED, labels: LABELS }, 2, 'Gazette_V2', [
      'G_1972_V2_No1.pdf',
      'G_1972_V2_No2.pdf',
      'G_1972-73_V2_No3.pdf',
      'G_1973_V2_No4.pdf',
    ]);
    expect(r.findings).toEqual([]);
    expect(r.years).toEqual({ from: 1972, to: 1973 });
  });

  it('notes an issue dated before the issue it follows', () => {
    const r = checkSequence({ patterns: DATED, labels: LABELS }, 5, 'Gazette_V5', ['G_1976_V5_No1.pdf', 'G_1975_V5_No2.pdf']);
    expect(r.findings).toEqual([
      {
        file: 'G_1975_V5_No2.pdf',
        effect: 'note',
        problem: 'issue 2 is dated 1975, before issue 1 (1976) -- the dates run backwards',
        fix: 'check the year in its name against the issue itself; rename it if the name is wrong',
      },
    ]);
  });
});

describe('checkBatch', () => {
  it('notes a volume number with no folder', () => {
    expect(
      checkBatch(LABELS, [
        { folder: 'G_V1', group: 1, years: null },
        { folder: 'G_V3', group: 3, years: null },
      ]),
    ).toEqual([
      {
        folder: '',
        file: '',
        effect: 'note',
        problem: 'no folder for volume 2 (volumes 1 to 3 found)',
        fix: 'check whether it exists; if the run is genuinely incomplete, nothing is needed',
      },
    ]);
  });

  it('notes two folders claiming one volume', () => {
    expect(
      checkBatch(LABELS, [
        { folder: 'G_V4', group: 4, years: null },
        { folder: 'G_V04', group: 4, years: null },
      ]),
    ).toEqual([
      expect.objectContaining({
        folder: 'G_V4, G_V04',
        problem: '2 folders claim volume 4',
      }),
    ]);
  });

  it('notes a volume dated before the volume it follows', () => {
    expect(
      checkBatch(LABELS, [
        { folder: 'G_V7', group: 7, years: { from: 1978, to: 1978 } },
        { folder: 'G_V8', group: 8, years: { from: 1976, to: 1976 } },
      ]),
    ).toEqual([
      expect.objectContaining({
        folder: 'G_V8',
        problem: 'volume 8 is dated from 1976, before volume 7 (from 1978) -- the dates run backwards',
      }),
    ]);
  });

  it('says nothing about a clean run, or about folders with no volume', () => {
    expect(
      checkBatch(LABELS, [
        { folder: 'G_V1', group: 1, years: { from: 1971, to: 1972 } },
        { folder: 'G_V2', group: 2, years: { from: 1972, to: 1973 } },
        { folder: 'Extras', group: null, years: null },
      ]),
    ).toEqual([]);
  });
});

describe('labels', () => {
  it('defaults to neutral words, and makes plurals with -s', () => {
    expect(resolveLabels()).toEqual({ part: 'part', parts: 'parts', group: 'group', groups: 'groups' });
    expect(resolveLabels({ part: 'folio' })).toMatchObject({ part: 'folio', parts: 'folios' });
  });

  it("takes a plural the template states, since not every word adds -s", () => {
    expect(resolveLabels({ group: 'box', groups: 'boxes' })).toMatchObject({ group: 'box', groups: 'boxes' });
  });

  it("speaks the template's words in every message", () => {
    const rule = { patterns: ['Box{group}_f{part}'], labels: resolveLabels({ part: 'folio', group: 'box', groups: 'boxes' }) };
    const r = checkSequence(rule, 4, 'Box4', ['Box4_f1.tif', 'Box4_f1b.tif', 'Box5_f2.tif']);
    expect(r.findings.map((f) => f.problem)).toEqual([
      "its name says box 5, but it is in the folder for box 4 ('Box4')",
      '2 files claim folio 1',
    ]);
    expect(checkBatch(rule.labels, [
      { folder: 'Box1', group: 1, years: null },
      { folder: 'Box4', group: 4, years: null },
    ])[0]?.problem).toBe('no folder for boxes 2, 3 (boxes 1 to 4 found)');
  });

  it('reads neutrally when a template gives no labels', () => {
    const r = checkSequence({ patterns: ['No{part}'], labels: resolveLabels() }, null, 'X', ['a_No1.pdf', 'b_No1.pdf']);
    expect(r.findings[0]?.problem).toBe('2 files claim part 1');
  });
});
