// src/core/folderFiles.ts
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The ONE order a folder's files are uploaded in. Used by plan and extractor
 * alike, so the spreadsheet and the contribution cannot disagree.
 *
 * Natural (Issue9 before Issue10), case-blind, punctuation-blind. Ties --
 * names the collator calls equal -- are broken by plain code-unit order, so
 * the result never depends on the order readdir happened to return.
 *
 * IT IS A RULE, NOT A JUDGEMENT. It cannot know that a commemorative issue
 * belongs last or that a misfiled issue belongs elsewhere, and it puts a
 * hyphenated year range (`1972-73`) BEFORE the plain year: with punctuation
 * ignored the comparison reaches `73` against `Vol`, and digits sort before
 * letters. The remedy for all of these is renaming the file, by the
 * operator's decision of 2026-11-13, and the plan prints each folder's order
 * so it can be checked before anything is uploaded.
 */
const COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
  ignorePunctuation: true,
});

export function orderFiles(names: readonly string[]): string[] {
  return [...names].sort((a, b) => COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

const SYSTEM_FILES: Record<string, string> = {
  'thumbs.db': 'a Windows thumbnail cache',
  'desktop.ini': 'a Windows folder settings file',
  '.ds_store': 'a macOS folder settings file',
};

/**
 * Why this name is never uploaded, or null when it is an ordinary file.
 *
 * A short fixed list rather than a judgement about file types: every file
 * the operator put in a folder is uploaded, whatever it is, except the ones
 * an operating system or Office puts there without being asked.
 */
export function clutterReason(name: string): string | null {
  const fixed = SYSTEM_FILES[name.toLowerCase()];
  if (fixed !== undefined) return fixed;
  if (name.startsWith('~$')) return 'an Office lock file';
  if (name.startsWith('.')) return 'a hidden file';
  return null;
}

export interface FolderFiles {
  /** In upload order. */
  files: { name: string; size: number }[];
  /** Never uploaded, each with the reason. Shown, never silent. */
  skipped: { name: string; reason: string }[];
  /** Set when the folder must not become a contribution at all. */
  refusal?: string;
}

/**
 * What one folder contributes.
 *
 * A refusal is never a partial answer. A folder holding a folder is not
 * uploaded with fewer files than it holds: an item missing an issue reads as
 * complete to everyone who later finds it, in a collection with no
 * moderation queue to catch it.
 */
export async function listFolderFiles(dir: string): Promise<FolderFiles> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skipped: FolderFiles['skipped'] = [];
  const nested: string[] = [];
  const names: string[] = [];

  for (const entry of entries) {
    const clutter = clutterReason(entry.name);
    if (clutter !== null) {
      skipped.push({ name: entry.name, reason: clutter });
    } else if (entry.isDirectory()) {
      nested.push(entry.name);
    } else if (entry.isFile()) {
      names.push(entry.name);
    } else {
      skipped.push({ name: entry.name, reason: 'not an ordinary file' });
    }
  }

  const files: FolderFiles['files'] = [];
  for (const name of orderFiles(names)) {
    files.push({ name, size: (await stat(join(dir, name))).size });
  }

  let refusal: string | undefined;
  if (nested.length > 0) {
    refusal =
      `it holds ${nested.length === 1 ? 'a folder' : 'folders'} ` +
      `(${orderFiles(nested)
        .map((n) => `'${n}'`)
        .join(', ')}); a folder inside a folder is not uploaded -- move its files up into ` +
      `this folder or out of it`;
  } else if (files.length === 0) {
    refusal = skipped.length > 0 ? 'the folder holds only skipped files' : 'the folder is empty';
  }

  return refusal === undefined ? { files, skipped } : { files, skipped, refusal };
}
