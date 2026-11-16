// src/core/extract/sequenceChecks.ts
import { applyPattern, placeholders } from './pattern.js';
import type { FolderProblem, SequenceLabels } from './types.js';

/**
 * Checking and ordering a folder's PARTS before it becomes one item.
 *
 * Built for serials kept as one folder per volume, after a real 38-volume
 * batch turned up an issue filed in the wrong volume, two different files both
 * numbered issue 3, and a volume whose years cross a boundary so that name
 * order put issue 3 first. NOTHING HERE KNOWS WHAT A JOURNAL IS: the same
 * shape is a manuscript's folios in a box, an album's pages, an interview's
 * sessions. So the vocabulary is neutral --
 *
 *   {part}   a file's position within its folder (an issue, a folio, a page)
 *   {group}  what the folder is (a volume, a box, an interview); read from the
 *            folder name through the profile's own `pattern`
 *   {year}   a year, or a span such as 1972-73
 *
 * -- and the template supplies its own words for the messages (`labels`), so
 * an operator reads "2 files claim issue 3", not "2 files claim part 3".
 * Neutral by the operator's decision of 2026-11-16, made BEFORE the first
 * release so that no template is ever written in journal-only terms.
 *
 * THE PATTERNS CHECK AND ORDER, NEVER MOVE. Within a folder, part numbers set
 * the order (`orderBySequence`), and it reaches the upload through the
 * spreadsheet's `attachment order` column, because `plan` never sees a
 * template. A folder with a file of another group, or two files claiming one
 * part, is held back for a person; everything else is a note. PURE -- no I/O.
 */

/** A template's words for its parts and groups. Declared with the profile types. */
export type { SequenceLabels };

/**
 * A template's labels with every gap filled: `part` and `group` when it says
 * nothing, and a plural made by adding "s" when it gives only the singular.
 * A plural that is not "+s" (`box` -> `boxes`) is the template's to state.
 */
export function resolveLabels(given: Partial<SequenceLabels> = {}): SequenceLabels {
  const part = given.part ?? 'part';
  const group = given.group ?? 'group';
  return {
    part,
    parts: given.parts ?? `${part}s`,
    group,
    groups: given.groups ?? `${group}s`,
  };
}

/** What the checks are run with: the template's patterns and its words. */
export interface SequenceRule {
  patterns: readonly string[];
  labels: SequenceLabels;
}

/** One thing the operator should know about a folder. */
export interface SequenceFinding {
  /** The file(s) concerned, or '' when the finding is about the folder. */
  file: string;
  /** `held back`: the folder is left out of the spreadsheet. `note`: it is not. */
  effect: 'held back' | 'note';
  problem: string;
  /** What to do about it, in words an operator can act on. */
  fix: string;
}

/** The longest span `parseParts` will read as a range, so a year is never one. */
const MAX_RANGE = 12;

/**
 * The part numbers one file covers. `No2&3` is one file holding parts 2 and
 * 3; `&`, `+` and `,` list numbers and `-` spans them. A dash followed by
 * something that cannot be the end of a short range -- `3-1974` -- ends the
 * reading at the number before it, so a year after a part is never taken for
 * parts 3 to 1974.
 */
export function parseParts(text: string): number[] {
  const parts: number[] = [];
  const tokens = text.match(/\d+|[&+,-]/g) ?? [];
  let previous: number | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (/^\d+$/.test(token)) {
      previous = Number(token);
      parts.push(previous);
    } else if (token === '-') {
      const end = Number(tokens[i + 1]);
      if (previous === null || !(end > previous && end - previous <= MAX_RANGE)) break;
      for (let n = previous + 1; n <= end; n += 1) parts.push(n);
      previous = end;
      i += 1;
    }
  }
  return parts;
}

/** The folder's group, read through the profile's own pattern; null when it gives none. */
export function folderGroup(profilePattern: string, folderName: string): number | null {
  const value = applyPattern(profilePattern, folderName)?.['group'];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

const PART_TEXT = String.raw`\d+(?:\s*[&+,-]\s*\d+)*`;

/** A check pattern as an unanchored, case-blind regex: {part} and {group} are digits. */
function compile(pattern: string): { regex: RegExp; names: string[] } {
  const names = placeholders(pattern);
  const source = pattern
    .split(/(\{[A-Za-z][A-Za-z0-9_]*\})/)
    .map((piece) => {
      if (piece === '{part}') return `(${PART_TEXT})`;
      if (piece === '{group}') return String.raw`(\d+)`;
      // A year, or a span such as 1972-73 for a part published across a year
      // boundary -- a real volume of the first serial does exactly that.
      if (piece === '{year}') return String.raw`(\d{4}(?:\s*-\s*\d{2,4})?)`;
      return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
): { parts: number[]; group: number | null; years: YearSpan | null } | null {
  for (const { regex, names } of compiled) {
    const match = regex.exec(name);
    if (!match) continue;
    const part = match[names.indexOf('part') + 1] ?? '';
    const groupAt = names.indexOf('group');
    const yearAt = names.indexOf('year');
    return {
      parts: parseParts(part),
      group: groupAt === -1 ? null : Number(match[groupAt + 1]),
      years: yearAt === -1 ? null : parseYears(match[yearAt + 1] ?? ''),
    };
  }
  return null;
}

const listed = (numbers: number[]) => numbers.join(', ');

/**
 * A folder's files in PART order: numbered files by part (the lowest, for a
 * combined `No2&3`), then the files no pattern numbers, last.
 *
 * WHY NUMBERS AND NOT NAMES. A volume can run across a year boundary -- one in
 * the real batch is 1972, 1972-73 and 1973 -- so a year in a name says nothing
 * about where an issue falls, and name order put issue 3 first. The part
 * number is the publisher's own statement of sequence. Operator's decision,
 * 2026-11-16.
 *
 * STABLE: `fileNames` arrives in name order (folderFiles.ts#orderFiles), and a
 * tie, an unnumbered file, or a template with no patterns keeps that order.
 */
export function orderBySequence(patterns: readonly string[], fileNames: readonly string[]): string[] {
  if (patterns.length === 0) return [...fileNames];
  const compiled = patterns.map(compile);
  const keyed = fileNames.map((name, index) => {
    const parts = read(compiled, name)?.parts ?? [];
    return { name, index, part: parts.length === 0 ? Infinity : Math.min(...parts) };
  });
  return keyed.sort((a, b) => a.part - b.part || a.index - b.index).map((k) => k.name);
}

/**
 * Check one folder's files.
 *
 * `numbered` counts the files a pattern matched, so the caller can tell a
 * clean batch from one the patterns never matched at all -- the second is a
 * check that did not run, and must be reported as one rather than as clean.
 * `years` is the span the folder's dated files cover, for `checkBatch`.
 */
export function checkSequence(
  rule: SequenceRule,
  group: number | null,
  folderName: string,
  fileNames: readonly string[],
): { findings: SequenceFinding[]; numbered: number; years: YearSpan | null } {
  const L = rule.labels;
  const compiled = rule.patterns.map(compile);
  const findings: SequenceFinding[] = [];
  const byPart = new Map<number, string[]>();
  let numbered = 0;
  let groupUnchecked = false;
  // Every dated file that belongs here, for the date checks after the loop.
  const dated: { name: string; part: number; years: YearSpan }[] = [];

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
        problem: `no ${L.part} number in its name; it is attached after the numbered ${L.parts}`,
        fix: `nothing, if last is its place; otherwise rename it so a pattern finds its ${L.part} number`,
      });
      continue;
    }
    numbered += 1;

    if (found.group !== null && group === null) groupUnchecked = true;
    // NEVER MOVED, only held back. The name or the folder could be the wrong
    // one -- a misnamed file in the right place looks exactly like a rightly
    // named file in the wrong one -- and only a person can tell which.
    if (found.group !== null && group !== null && found.group !== group) {
      findings.push({
        file: name,
        effect: 'held back',
        problem: `its name says ${L.group} ${found.group}, but it is in the folder for ${L.group} ${group} ('${folderName}')`,
        fix:
          `move it into the folder for ${L.group} ${found.group}, then build the spreadsheet again -- ` +
          'or, if this folder is right, correct the file name',
      });
      // Left out of this folder's numbering: it is not one of its parts.
      continue;
    }
    for (const part of found.parts) byPart.set(part, [...(byPart.get(part) ?? []), name]);
    if (found.years !== null && found.parts.length > 0) {
      dated.push({ name, part: Math.min(...found.parts), years: found.years });
    }
  }

  for (const [part, files] of [...byPart].sort(([a], [b]) => a - b)) {
    if (files.length < 2) continue;
    findings.push({
      file: files.join(', '),
      effect: 'held back',
      problem: `${files.length} files claim ${L.part} ${part}`,
      fix: `keep the right one, or rename the other so its ${L.part} number is correct, then build the spreadsheet again`,
    });
  }

  const parts = [...byPart.keys()];
  if (parts.length > 0) {
    const highest = Math.max(...parts);
    const lowest = Math.min(...parts);
    const missing: number[] = [];
    for (let n = lowest + 1; n < highest; n += 1) if (!byPart.has(n)) missing.push(n);
    if (missing.length > 0) {
      const found = lowest === highest ? `${L.part} ${lowest} found` : `${L.parts} ${lowest} to ${highest} found`;
      findings.push({
        file: '',
        effect: 'note',
        problem:
          `${missing.length === 1 ? L.part : L.parts} ${listed(missing)} ` +
          `${missing.length === 1 ? 'is' : 'are'} missing from the numbering (${found}); ` +
          `a missing FIRST or LAST ${L.part} cannot be detected`,
        fix: `check whether it exists; if the ${L.group} is genuinely incomplete, nothing is needed`,
      });
    }
  }

  if (groupUnchecked) {
    findings.push({
      file: '',
      effect: 'note',
      problem: `the folder name '${folderName}' gives no ${L.group} number, so its files were not checked against one`,
      fix: `rename the folder to match the profile's pattern if it is a ${L.group}`,
    });
  }

  // DATES, IN PART ORDER. A volume may cross a year boundary, so dates may
  // stay the same or move on; going BACKWARDS means a year or a part number in
  // some name is wrong. A note, not a hold: only the part itself can say
  // which, and it may be the publisher's own irregularity.
  const inOrder = [...dated].sort((a, b) => a.part - b.part);
  for (let i = 1; i < inOrder.length; i += 1) {
    const previous = inOrder[i - 1]!;
    const current = inOrder[i]!;
    if (current.years.from < previous.years.from) {
      findings.push({
        file: current.name,
        effect: 'note',
        problem:
          `${L.part} ${current.part} is dated ${showYears(current.years)}, before ${L.part} ${previous.part} ` +
          `(${showYears(previous.years)}) -- the dates run backwards`,
        fix: `check the year in its name against the ${L.part} itself; rename it if the name is wrong`,
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
export interface GroupSummary {
  folder: string;
  /** From the folder name, through the profile's `pattern`; null when it gives none. */
  group: number | null;
  /** The years its dated files span; null when none is dated. */
  years: YearSpan | null;
}

/**
 * Checks across the whole batch: groups are a run, and the run can be
 * inconsistent in ways no single folder shows. NOTES ONLY -- each could be
 * the publisher's own irregularity, and only a person with the material in
 * front of them can say.
 *
 * - a group number between the lowest and highest with no folder;
 * - two folders claiming one group;
 * - a group dated before the group it follows.
 */
export function checkBatch(labels: SequenceLabels, groups: readonly GroupSummary[]): FolderProblem[] {
  const L = labels;
  const problems: FolderProblem[] = [];
  const numbered = groups.filter((g): g is GroupSummary & { group: number } => g.group !== null);
  if (numbered.length === 0) return problems;

  const byGroup = new Map<number, GroupSummary[]>();
  for (const g of numbered) byGroup.set(g.group, [...(byGroup.get(g.group) ?? []), g]);
  const present = [...byGroup.keys()].sort((a, b) => a - b);
  const lowest = present[0]!;
  const highest = present[present.length - 1]!;

  const missing: number[] = [];
  for (let n = lowest + 1; n < highest; n += 1) if (!byGroup.has(n)) missing.push(n);
  if (missing.length > 0) {
    problems.push({
      folder: '',
      file: '',
      effect: 'note',
      problem:
        `no folder for ${missing.length === 1 ? L.group : L.groups} ${listed(missing)} ` +
        `(${L.groups} ${lowest} to ${highest} found)`,
      fix: 'check whether it exists; if the run is genuinely incomplete, nothing is needed',
    });
  }

  for (const [group, folders] of byGroup) {
    if (folders.length < 2) continue;
    problems.push({
      folder: folders.map((f) => f.folder).join(', '),
      file: '',
      effect: 'note',
      problem: `${folders.length} folders claim ${L.group} ${group}`,
      fix: `rename the folder whose number is wrong, or merge them if they are one ${L.group}`,
    });
  }

  // Compared by where each group STARTS, in group order. Volumes share a year
  // at their boundary routinely; starting earlier than the one before is the
  // inconsistency.
  let previous: (GroupSummary & { group: number; years: YearSpan }) | null = null;
  for (const group of present) {
    for (const g of byGroup.get(group)!) {
      if (g.years === null) continue;
      const dated = g as GroupSummary & { group: number; years: YearSpan };
      if (previous !== null && previous.group !== group && dated.years.from < previous.years.from) {
        problems.push({
          folder: g.folder,
          file: '',
          effect: 'note',
          problem:
            `${L.group} ${group} is dated from ${dated.years.from}, before ${L.group} ${previous.group} ` +
            `(from ${previous.years.from}) -- the dates run backwards`,
          fix: `check the folder's ${L.group} number and the years in its file names`,
        });
      }
      previous = dated;
    }
  }
  return problems;
}
