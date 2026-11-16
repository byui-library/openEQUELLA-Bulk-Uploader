// src/core/extract/issueChecks.ts
import { applyPattern, placeholders } from './pattern.js';

/**
 * Checking a folder's ARRANGEMENT before it becomes one item.
 *
 * Built for serials kept as one folder per volume, after a real 38-volume
 * batch turned up a Vol 2 issue filed in Vol 3 and two different files both
 * numbered issue 3 -- neither of which anything else in the tool would have
 * noticed, and both of which would have become permanent records in a
 * collection with no moderation queue.
 *
 * CHECKING ONLY, by the operator's decision of 2026-11-16 ("Option C"). The
 * order files are attached in is `folderFiles.ts#orderFiles`, untouched; the
 * remedy for a wrong order is renaming. These patterns are what lets the tool
 * SAY something is wrong, never what lets it rearrange anything.
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
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return { regex: new RegExp(source, 'i'), names };
}

/** What a name says, by the first pattern that matches it. */
function read(
  compiled: ReturnType<typeof compile>[],
  name: string,
): { issues: number[]; volume: number | null } | null {
  for (const { regex, names } of compiled) {
    const match = regex.exec(name);
    if (!match) continue;
    const issue = match[names.indexOf('issue') + 1] ?? '';
    const volumeAt = names.indexOf('volume');
    return {
      issues: parseIssues(issue),
      volume: volumeAt === -1 ? null : Number(match[volumeAt + 1]),
    };
  }
  return null;
}

const listed = (numbers: number[]) => numbers.join(', ');

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
): { findings: IssueFinding[]; numbered: number } {
  const compiled = patterns.map(compile);
  const findings: IssueFinding[] = [];
  const byIssue = new Map<number, string[]>();
  let numbered = 0;
  let volumeUnchecked = false;

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
        problem: 'no issue number in its name; it is attached in name order like any other file',
        fix: 'nothing, if its place in the plan is right; otherwise rename it to move it',
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

  return { findings, numbered };
}
