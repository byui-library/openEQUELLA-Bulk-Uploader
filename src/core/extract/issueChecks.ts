// src/core/extract/issueChecks.ts
import { applyPattern, placeholders } from './pattern.js';
import type { FolderProblem } from './types.js';

/**
 * Checking a folder's ARRANGEMENT before it becomes one item.
 *
 * Built for serials kept as one folder per volume, after a real 38-volume
 * batch turned up a Vol 2 issue filed in Vol 3 and two different files both
 * numbered issue 3 -- neither of which anything else in the tool would have
 * noticed, and both of which would have become permanent records in a
 * collection with no moderation queue.
 *
 * THE PATTERNS CHECK AND ORDER, NEVER MOVE. They began as checking only
 * ("Option C", 2026-11-16); later that day the operator decided issue numbers
 * take precedence over names within a folder -- see `orderByIssue`. That order
 * reaches the upload through the spreadsheet's `attachment order` column,
 * because `plan` never sees a template. No file is ever moved or renamed here:
 * a held-back folder waits for a person.
 *
 * NOTHING HERE KNOWS ABOUT ANY JOURNAL. The patterns come from the template,
 * the folder's volume from the template's own `pattern`. PURE -- no I/O.
 */

/** One thing the operator should know about a folder. */
export interface IssueFinding {
  /** The file(s) concerned, or '' when the finding is about the folder. */
  file: string;
  /** `held back`: the folder is left out of the spreadsheet. `note`: it is not. */
  effect: 'held back' | 'note';
  problem: string;
  /** What to do about it, in words an operator can act on. */
  fix: string;
}

/** The longest span `parseIssues` will read as a range, so a year is never one. */
const MAX_RANGE = 12;

/**
 * The issue numbers one file covers. `No2&3` is one file holding issues 2 and
 * 3; `&`, `+` and `,` list numbers and `-` spans them. A dash followed by
 * something that cannot be the end of a short range -- `3-1974` -- ends the
 * reading at the number before it, so a year after an issue is never taken
 * for issues 3 to 1974.
 */
export function parseIssues(text: string): number[] {
  const issues: number[] = [];
  const tokens = text.match(/\d+|[&+,-]/g) ?? [];
  let previous: number | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (/^\d+$/.test(token)) {
      previous = Number(token);
      issues.push(previous);
    } else if (token === '-') {
      const end = Number(tokens[i + 1]);
      if (previous === null || !(end > previous && end - previous <= MAX_RANGE)) break;
      for (let n = previous + 1; n <= end; n += 1) issues.push(n);
      previous = end;
      i += 1;
    }
  }
  return issues;
}

/** The folder's volume, read through the profile's own pattern; null when it gives none. */
export function folderVolume(profilePattern: string, folderName: string): number | null {
  const value = applyPattern(profilePattern, folderName)?.['volume'];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

const ISSUE_TEXT = String.raw`\d+(?:\s*[&+,-]\s*\d+)*`;

/** A check pattern as an unanchored, case-blind regex: {issue} and {volume} are digits. */
function compile(pattern: string): { regex: RegExp; names: string[] } {
  const names = placeholders(pattern);
  const source = pattern
    .split(/(\{[A-Za-z][A-Za-z0-9_]*\})/)
    .map((part) => {
      if (part === '{issue}') return `(${ISSUE_TEXT})`;
      if (part === '{volume}') return String.raw`(\d+)`;
      // A year, or a span such as 1972-73 for an issue published across a
      // year boundary -- a real volume of the first serial does exactly that.
      if (part === '{year}') return String.raw`(\d{4}(?:\s*-\s*\d{2,4})?)`;
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return { regex: new RegExp(source, 'i'), names };
}

/** A year or year span as written in a name: `1972`, `1972-73`, `1999-2000`. */
export interface YearSpan {
  from: number;
  to: number;
}

/** `1972-73` -> 1972 to 1973; a two-digit end belongs to the start's century, or the next. */
export function parseYears(text: string): YearSpan {
  const [start, end] = text.split('-').map((s) => s.trim());
  const from = Number(start);
  if (end === undefined || end === '') return { from, to: from };
  let to = Number(end);
  if (end.length <= 2) {
    to += Math.floor(from / 100) * 100;
    if (to < from) to += 100;
  }
  return { from, to: Math.max(from, to) };
}

const showYears = (y: YearSpan) => (y.from === y.to ? `${y.from}` : `${y.from}-${y.to}`);

/** What a name says, by the first pattern that matches it. */
function read(
  compiled: ReturnType<typeof compile>[],
  name: string,
): { issues: number[]; volume: number | null; years: YearSpan | null } | null {
  for (const { regex, names } of compiled) {
    const match = regex.exec(name);
    if (!match) continue;
    const issue = match[names.indexOf('issue') + 1] ?? '';
    const volumeAt = names.indexOf('volume');
    const yearAt = names.indexOf('year');
    return {
      issues: parseIssues(issue),
      volume: volumeAt === -1 ? null : Number(match[volumeAt + 1]),
      years: yearAt === -1 ? null : parseYears(match[yearAt + 1] ?? ''),
    };
  }
  return null;
}

const listed = (numbers: number[]) => numbers.join(', ');

/**
 * A folder's files in ISSUE order: numbered files by issue (the lowest, for a
 * combined `No2&3`), then the files no pattern numbers, last.
 *
 * WHY NUMBERS AND NOT NAMES. A volume can run across a year boundary -- one in
 * the real batch is 1972, 1972-73 and 1973 -- so a year in a name says nothing
 * about where an issue falls, and name order put issue 3 first. The issue
 * number is the publisher's own statement of sequence. Operator's decision,
 * 2026-11-16, superseding "checking only".
 *
 * STABLE: `fileNames` arrives in name order (folderFiles.ts#orderFiles), and a
 * tie, an unnumbered file, or a template with no patterns keeps that order.
 */
export function orderByIssue(patterns: readonly string[], fileNames: readonly string[]): string[] {
  if (patterns.length === 0) return [...fileNames];
  const compiled = patterns.map(compile);
  const keyed = fileNames.map((name, index) => {
    const issues = read(compiled, name)?.issues ?? [];
    return { name, index, issue: issues.length === 0 ? Infinity : Math.min(...issues) };
  });
  return keyed.sort((a, b) => a.issue - b.issue || a.index - b.index).map((k) => k.name);
}

/**
 * Check one folder's files, in attachment order.
 *
 * `numbered` counts the files a pattern matched, so the caller can tell a
 * clean batch from one the patterns never matched at all -- the second is a
 * check that did not run, and must be reported as one rather than as clean.
 */
export function checkIssues(
  patterns: readonly string[],
  volume: number | null,
  folderName: string,
  fileNames: readonly string[],
): { findings: IssueFinding[]; numbered: number; years: YearSpan | null } {
  const compiled = patterns.map(compile);
  const findings: IssueFinding[] = [];
  const byIssue = new Map<number, string[]>();
  let numbered = 0;
  let volumeUnchecked = false;
  // Every dated file that belongs here, for the date checks after the loop.
  const dated: { name: string; issue: number; years: YearSpan }[] = [];

  for (const name of fileNames) {
    const found = read(compiled, name);
    if (found === null) {
      // The note is about PLACE in the attachment order, and a file alone in
      // its folder has none to get wrong -- a whole volume scanned as one PDF
      // is the common case, and noting every one of those teaches the operator
      // to skim the log.
      if (fileNames.length === 1) continue;
      findings.push({
        file: name,
        effect: 'note',
        problem: 'no issue number in its name; it is attached after the numbered issues',
        fix: 'nothing, if last is its place; otherwise rename it so a pattern finds its issue number',
      });
      continue;
    }
    numbered += 1;

    if (found.volume !== null && volume === null) volumeUnchecked = true;
    // NEVER MOVED, only held back. The name or the folder could be the wrong
    // one -- a misnamed file in the right place looks exactly like a rightly
    // named file in the wrong one -- and only a person can tell which.
    if (found.volume !== null && volume !== null && found.volume !== volume) {
      findings.push({
        file: name,
        effect: 'held back',
        problem: `its name says volume ${found.volume}, but it is in the folder for volume ${volume} ('${folderName}')`,
        fix:
          `move it into the folder for volume ${found.volume}, then build the spreadsheet again -- ` +
          'or, if this folder is right, correct the file name',
      });
      // Left out of this folder's numbering: it is not one of its issues.
      continue;
    }
    for (const issue of found.issues) byIssue.set(issue, [...(byIssue.get(issue) ?? []), name]);
    if (found.years !== null && found.issues.length > 0) {
      dated.push({ name, issue: Math.min(...found.issues), years: found.years });
    }
  }

  for (const [issue, files] of [...byIssue].sort(([a], [b]) => a - b)) {
    if (files.length < 2) continue;
    findings.push({
      file: files.join(', '),
      effect: 'held back',
      problem: `${files.length} files claim issue ${issue}`,
      fix: 'keep the right one, or rename the other so its issue number is correct, then build the spreadsheet again',
    });
  }

  const issues = [...byIssue.keys()];
  if (issues.length > 0) {
    const highest = Math.max(...issues);
    const lowest = Math.min(...issues);
    const missing: number[] = [];
    for (let n = 1; n < highest; n += 1) if (!byIssue.has(n)) missing.push(n);
    if (missing.length > 0) {
      const found = lowest === highest ? `issue ${lowest} found` : `issues ${lowest} to ${highest} found`;
      findings.push({
        file: '',
        effect: 'note',
        problem:
          `${missing.length === 1 ? 'issue' : 'issues'} ${listed(missing)} ` +
          `${missing.length === 1 ? 'is' : 'are'} missing from the numbering (${found}); ` +
          'a missing LAST issue cannot be detected',
        fix: 'check whether it exists; if the volume is genuinely incomplete, nothing is needed',
      });
    }
  }

  if (volumeUnchecked) {
    findings.push({
      file: '',
      effect: 'note',
      problem: `the folder name '${folderName}' gives no volume number, so its files were not checked against one`,
      fix: "rename the folder to match the profile's pattern if it is a volume",
    });
  }

  // DATES, IN ISSUE ORDER. A volume may cross a year boundary, so dates may
  // stay the same or move on; going BACKWARDS means a year or an issue number
  // in some name is wrong. A note, not a hold: only the issue itself can say
  // which, and it may be the publisher's own irregularity.
  const inOrder = [...dated].sort((a, b) => a.issue - b.issue);
  for (let i = 1; i < inOrder.length; i += 1) {
    const previous = inOrder[i - 1]!;
    const current = inOrder[i]!;
    if (current.years.from < previous.years.from) {
      findings.push({
        file: current.name,
        effect: 'note',
        problem:
          `issue ${current.issue} is dated ${showYears(current.years)}, before issue ${previous.issue} ` +
          `(${showYears(previous.years)}) -- the dates run backwards`,
        fix: 'check the year in its name against the issue itself; rename it if the name is wrong',
      });
    }
  }
  const years =
    dated.length === 0
      ? null
      : { from: Math.min(...dated.map((d) => d.years.from)), to: Math.max(...dated.map((d) => d.years.to)) };

  return { findings, numbered, years };
}

/** One folder as the batch-wide check sees it. */
export interface VolumeSummary {
  folder: string;
  /** From the folder name, through the profile's `pattern`; null when it gives none. */
  volume: number | null;
  /** The years its dated files span; null when none is dated. */
  years: YearSpan | null;
}

/**
 * Checks across the whole batch: volumes are a run, and the run can be
 * inconsistent in ways no single folder shows. NOTES ONLY -- each could be
 * the publisher's own irregularity, and only a person with the issues in
 * front of them can say.
 *
 * - a volume number between the lowest and highest with no folder;
 * - two folders claiming one volume;
 * - a volume dated before the volume it follows.
 */
export function checkBatch(volumes: readonly VolumeSummary[]): FolderProblem[] {
  const problems: FolderProblem[] = [];
  const numbered = volumes.filter((v): v is VolumeSummary & { volume: number } => v.volume !== null);
  if (numbered.length === 0) return problems;

  const byVolume = new Map<number, VolumeSummary[]>();
  for (const v of numbered) byVolume.set(v.volume, [...(byVolume.get(v.volume) ?? []), v]);
  const present = [...byVolume.keys()].sort((a, b) => a - b);
  const lowest = present[0]!;
  const highest = present[present.length - 1]!;

  const missing: number[] = [];
  for (let n = lowest + 1; n < highest; n += 1) if (!byVolume.has(n)) missing.push(n);
  if (missing.length > 0) {
    problems.push({
      folder: '',
      file: '',
      effect: 'note',
      problem:
        `no folder for ${missing.length === 1 ? 'volume' : 'volumes'} ${listed(missing)} ` +
        `(volumes ${lowest} to ${highest} found)`,
      fix: 'check whether it exists; if the run is genuinely incomplete, nothing is needed',
    });
  }

  for (const [volume, folders] of byVolume) {
    if (folders.length < 2) continue;
    problems.push({
      folder: folders.map((f) => f.folder).join(', '),
      file: '',
      effect: 'note',
      problem: `${folders.length} folders claim volume ${volume}`,
      fix: 'rename the folder whose number is wrong, or merge them if they are one volume',
    });
  }

  // Compared by where each volume STARTS, in volume order. Volumes share a
  // year at their boundary routinely; starting earlier than the one before is
  // the inconsistency.
  let previous: (VolumeSummary & { volume: number; years: YearSpan }) | null = null;
  for (const volume of present) {
    for (const v of byVolume.get(volume)!) {
      if (v.years === null) continue;
      const dated = v as VolumeSummary & { volume: number; years: YearSpan };
      if (previous !== null && previous.volume !== volume && dated.years.from < previous.years.from) {
        problems.push({
          folder: v.folder,
          file: '',
          effect: 'note',
          problem:
            `volume ${volume} is dated from ${dated.years.from}, before volume ${previous.volume} ` +
            `(from ${previous.years.from}) -- the dates run backwards`,
          fix: "check the folder's volume number and the years in its file names",
        });
      }
      previous = dated;
    }
  }
  return problems;
}
