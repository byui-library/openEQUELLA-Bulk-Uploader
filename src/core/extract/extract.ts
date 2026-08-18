// src/core/extract/extract.ts
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { buildRow } from './rows.js';
import { isSupported, readDocument, type DocumentReader } from './readers/index.js';
import type { DocumentData, ExtractResult, ExtractedRow, Profile } from './types.js';

export interface ExtractOptions {
  /** Injectable so orchestration can be tested without real files. */
  reader?: DocumentReader;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * Called with each row and the document it was built from, as it is built.
   *
   * IT EXISTS SO THE MODEL PASS DOES NOT RE-READ THE FOLDER. `core/ai/fill.ts`
   * runs after extraction and needs the document TEXT to slice, which this
   * function otherwise drops on the floor the moment a row is built. Without
   * the hook the only way to get it back is to open and parse every PDF a
   * second time -- on a four-hundred-file batch, doubling the slowest part of
   * the run to recover something that was in memory a moment earlier.
   *
   * A HOOK RATHER THAN A RETURNED LIST, so a caller that does not want the
   * documents does not hold four hundred of them in memory for the length of
   * the run. Nothing pays for this unless it asks.
   *
   * THIS DOES NOT MAKE EXTRACTION ASYNCHRONOUS OR NETWORKED. `src/core/extract/`
   * still never touches the network -- the hook hands out what was already read
   * from disk, and whatever the caller does with it happens in its own pass,
   * afterwards. That separation is what lets an operator build a spreadsheet
   * without signing in to anything.
   */
  onRow?: (row: ExtractedRow, doc: DocumentData) => void;
  /**
   * A listing already taken, instead of walking the directory again.
   *
   * THE CONSENT ARTIFACT AND THE RUN MUST COUNT THE SAME FILES. The CLI lists
   * the folder to tell the operator how many requests a model run will make, and
   * then this function listed it a second time to decide what to read. Two walks
   * of one directory can disagree -- a file arrives, a sync finishes, something
   * is deleted -- so the number somebody agreed to was a second opinion about
   * the batch rather than the batch itself. Passing the listing down makes it
   * one answer, and saves a walk of a four-hundred-file folder as a side effect.
   *
   * Omitted, this reads the folder itself, which is what every other caller
   * wants.
   */
  listing?: FolderListing;
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
  const { reader = readDocument, onProgress, signal, onRow } = options;

  const found = options.listing ?? (await listFolder(dir));
  const { supported } = found;
  // COPIED, never appended to in place. Read failures are pushed onto this
  // below, and a caller that handed its own listing in -- the CLI, which showed
  // the operator a count taken from it -- must not have that list grow
  // underneath it as a side effect of the run.
  const skipped = [...found.skipped];
  const rows: ExtractedRow[] = [];

  let done = 0;
  for (const name of supported) {
    if (signal?.aborted) break;
    try {
      const doc = await reader(join(dir, name));
      const row = buildRow(profile, name, doc);
      rows.push(row);
      onRow?.(row, doc);
    } catch (error) {
      skipped.push({ file: name, reason: (error as Error).message });
    }
    done += 1;
    onProgress?.(done, supported.length);
  }

  return { rows, skipped };
}
