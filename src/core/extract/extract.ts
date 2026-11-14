// src/core/extract/extract.ts
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { buildFolderRow, buildRow, type FolderDoc } from './rows.js';
import { clutterReason, listFolderFiles, orderFiles } from '../folderFiles.js';
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

export interface SubfolderListing {
  /**
   * Each subfolder that can become a row, in natural order. `files` is every
   * file it will upload, in attachment order; `readable` the ones a reader
   * can open, which are the only ones whose contents feed the row.
   */
  folders: { name: string; files: string[]; readable: string[] }[];
  /** Loose files and refused subfolders, each with a reason. */
  skipped: { file: string; reason: string }[];
}

/**
 * What a batch folder holds when each SUBFOLDER is to become one row.
 *
 * Uses folderFiles.ts for every subfolder, so the extractor sees exactly the
 * files -- and the order -- that `plan` will upload. A loose file is named
 * rather than ignored: the operator chose "one row per subfolder", and a file
 * beside the subfolders is either a mistake or a sign the wrong mode is on.
 */
export async function listSubfolders(dir: string): Promise<SubfolderListing> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skipped: SubfolderListing['skipped'] = [];
  for (const entry of entries) {
    if (entry.isFile() && clutterReason(entry.name) === null) {
      skipped.push({
        file: entry.name,
        reason:
          'a file directly in the chosen folder -- with one row per subfolder, only subfolders become rows',
      });
    }
  }

  const names = orderFiles(
    entries.filter((e) => e.isDirectory() && clutterReason(e.name) === null).map((e) => e.name),
  );
  const folders: SubfolderListing['folders'] = [];
  for (const name of names) {
    const listing = await listFolderFiles(join(dir, name));
    if (listing.refusal !== undefined) {
      skipped.push({ file: name, reason: listing.refusal });
      continue;
    }
    const files = listing.files.map((f) => f.name);
    folders.push({ name, files, readable: files.filter(isSupported) });
  }
  return { folders, skipped };
}

/**
 * One row per subfolder of `dir`.
 *
 * A subfolder's files become ONE item's attachments at upload, so a file the
 * readers cannot open is still part of that item: it is noted on the row,
 * never dropped from it, and never refuses it. That is the difference from
 * `extractFolder`, where an unreadable file has no row at all.
 *
 * THERE IS NO `onRow` HOOK, deliberately: the model pass does not run on
 * folder rows (see core/ai/fill.ts, 'folder-row'). A caller with model
 * columns notes them with `noteMissingModel(rows, profile, 'folder-row')`.
 */
export async function extractFolders(
  dir: string,
  profile: Profile,
  options: Pick<ExtractOptions, 'reader' | 'onProgress' | 'signal'> & { listing?: SubfolderListing } = {},
): Promise<ExtractResult> {
  const { reader = readDocument, onProgress, signal } = options;
  const found = options.listing ?? (await listSubfolders(dir));
  // Copied, never appended to in place -- the same reason as extractFolder.
  const skipped = [...found.skipped];
  const rows: ExtractedRow[] = [];

  let done = 0;
  for (const folder of found.folders) {
    if (signal?.aborted) break;
    const docs: FolderDoc[] = [];
    const unreadable: string[] = [];
    for (const name of folder.readable) {
      try {
        docs.push({ name, doc: await reader(join(dir, folder.name, name)) });
      } catch (error) {
        unreadable.push(
          `'${name}' could not be read (${(error as Error).message}); it is still uploaded with the others`,
        );
      }
    }
    const row = buildFolderRow(profile, folder.name, docs);
    row.notes.push(...unreadable);
    rows.push(row);
    done += 1;
    onProgress?.(done, found.folders.length);
  }

  return { rows, skipped };
}
