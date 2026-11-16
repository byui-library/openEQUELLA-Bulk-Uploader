// tests/extract/issueChecks.test.ts
import { describe, it, expect } from 'vitest';
import { checkIssues, folderVolume, parseIssues } from '../../src/core/extract/issueChecks.js';

const PATTERNS = ['V{volume}_No{issue}', 'V{volume}_Num{issue}'];

describe('parseIssues', () => {
  it.each([
    ['3', [3]],
    ['2&3', [2, 3]],
    ['2 & 3', [2, 3]],
    ['1+2', [1, 2]],
    ['2-4', [2, 3, 4]],
    ['10', [10]],
  ])('reads %s as %j', (text, issues) => expect(parseIssues(text)).toEqual(issues));

  it('does not read a year after a dash as the end of a range', () => {
    expect(parseIssues('3-1974')).toEqual([3]);
  });
});

describe('folderVolume', () => {
  it("reads the folder's {volume} from the profile pattern", () => {
    expect(folderVolume('Gazette_V{volume}', 'Gazette_V12')).toBe(12);
  });
  it('is null when the folder name does not match, or the value is not a number', () => {
    expect(folderVolume('Gazette_V{volume}', 'Extras')).toBeNull();
    expect(folderVolume('Gazette_V{volume}', 'Gazette_VX')).toBeNull();
    expect(folderVolume('{name}', 'Gazette_V12')).toBeNull();
  });
});

describe('checkIssues', () => {
  it('finds nothing to say about a clean run', () => {
    const r = checkIssues(PATTERNS, 4, 'Gazette_V4', ['G_1975_V4_No1.pdf', 'G_1975_V4_No2.pdf']);
    expect(r).toEqual({ findings: [], numbered: 2 });
  });

  it('holds the folder back for a file named for another volume, and leaves it out of the other checks', () => {
    const r = checkIssues(PATTERNS, 3, 'Gazette_V3', [
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
    const r = checkIssues(PATTERNS, 3, 'Gazette_V3', [
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
    const r = checkIssues(PATTERNS, 27, 'Gazette_V27', [
      'G_1998_Commemorative.pdf',
      'G_1998_V27_No1.pdf',
      'G_1998_V27_No2.pdf',
    ]);
    expect(r.findings).toEqual([
      {
        file: 'G_1998_Commemorative.pdf',
        effect: 'note',
        problem: 'no issue number in its name; it is attached in name order like any other file',
        fix: 'nothing, if its place in the plan is right; otherwise rename it to move it',
      },
    ]);
  });

  it('notes a gap, saying a missing last issue cannot be seen', () => {
    const r = checkIssues(PATTERNS, 5, 'Gazette_V5', ['G_V5_No1.pdf', 'G_V5_No2.pdf', 'G_V5_No4.pdf']);
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
    const r = checkIssues(PATTERNS, 5, 'Gazette_V5', ['G_V5_No3.pdf']);
    expect(r.findings[0]?.problem).toMatch(/^issues 1, 2 are missing/);
  });

  it('reads a combined issue as covering both numbers: no gap, no duplicate', () => {
    const r = checkIssues(PATTERNS, 4, 'Gazette_V4', ['G_V4_No1.pdf', 'G_V4_No2&3.pdf', 'G_V4_No4.pdf']);
    expect(r.findings).toEqual([]);
  });

  it('matches anywhere in the name, ignoring case and a hyphenated year before it', () => {
    const r = checkIssues(PATTERNS, 2, 'Gazette_V2', ['G_1972-73_v2_no3.pdf', 'G_1972_V2_No1.pdf', 'G_1972_V2_No2.pdf']);
    expect(r).toEqual({ findings: [], numbered: 3 });
  });

  it('cannot compare volumes when the folder gives none, and says so once', () => {
    const r = checkIssues(PATTERNS, null, 'Extras', ['G_V2_No1.pdf', 'G_V3_No2.pdf']);
    expect(r.findings).toEqual([
      {
        file: '',
        effect: 'note',
        problem: "the folder name 'Extras' gives no volume number, so its files were not checked against one",
        fix: "rename the folder to match the profile's pattern if it is a volume",
      },
    ]);
  });

  it('a pattern without {volume} checks issues only', () => {
    const r = checkIssues(['No{issue}'], null, 'Anything', ['a_No1.pdf', 'b_No1.pdf']);
    expect(r.findings[0]).toMatchObject({ effect: 'held back', problem: '2 files claim issue 1' });
  });
});
