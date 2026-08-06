// src/core/extract/extract.ts
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { buildRow } from './rows.js';
import { isSupported, readDocument, type DocumentReader } from './readers/index.js';
import type { ExtractResult, ExtractedRow, Profile } from './types.js';

export interface ExtractOptions {
  /** Injectable so orchestration can be tested without real files. */
  reader?: DocumentReader;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

function skipReason(filename: string): string {
  const extension = extname(filename).toLowerCase();
  if (extension === '.doc') {
    return 'Word 2003 and earlier (.doc) cannot be read -- save as .docx first';
  }
  return `unsupported file type '${extension || 'none'}'`;
}

export interface FolderListing {
  /** Files the readers can open, sorted. */
  supported: string[];
  /** Everything else, each with a reason the operator can act on. */
  skipped: { file: string; reason: string }[];
}

/**
 * What is in a folder, split into what can be read and what cannot.
 *
 * Exported because the desktop app's folder-scan screen needs exactly this and
 * had reimplemented it — including a shorter `skipReason` that omitted the
 * extension, so the same file was described one way on the scan screen and
 * another way in the run that followed. One implementation, one wording.
 */
export async function listFolder(dir: string): Promise<FolderListing> {
  const listing = await readdir(dir, { withFileTypes: true });
  const filenames = listing
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return {
    supported: filenames.filter(isSupported),
    skipped: filenames
      .filter((n) => !isSupported(n))
      .map((file) => ({ file, reason: skipReason(file) })),
  };
}

/**
 * Read every supported file in `dir` and build one row each.
 *
 * Files are processed one at a time and failures are isolated: a single
 * unreadable PDF must not abort a three-hundred-file run. This mirrors the
 * per-row isolation src/core/runner.ts already uses for uploads.
 */
export async function extractFolder(
  dir: string,
  profile: Profile,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const { reader = readDocument, onProgress, signal } = options;

  const { supported, skipped } = await listFolder(dir);
  const rows: ExtractedRow[] = [];

  let done = 0;
  for (const name of supported) {
    if (signal?.aborted) break;
    try {
      const doc = await reader(join(dir, name));
      rows.push(buildRow(profile, name, doc));
    } catch (error) {
      skipped.push({ file: name, reason: (error as Error).message });
    }
    done += 1;
    onProgress?.(done, supported.length);
  }

  return { rows, skipped };
}
