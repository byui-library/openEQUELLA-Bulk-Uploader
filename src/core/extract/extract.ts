// src/core/extract/extract.ts
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { buildFolderRow, buildRow, type FolderDoc } from './rows.js';
import { clutterReason, listFolderFiles, orderFiles } from '../folderFiles.js';
import { isSupported, readDocument, type DocumentReader } from './readers/index.js';
import type { DocumentData, ExtractResult, ExtractedRow, FolderProblem, Profile } from './types.js';
import {
  checkBatch,
  checkSequence,
  folderGroup,
  orderBySequence,
  resolveLabels,
  type GroupSummary,
  type SequenceRule,
} from './sequenceChecks.js';

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
/** Why a file beside the subfolders is not a row. One constant, so the log can tell it from a refused folder. */
const LOOSE_FILE_REASON =
  'a file directly in the chosen folder -- with one row per subfolder, only subfolders become rows';

/** What the problems log says a held-back folder's skipped entry means. */
const HELD_BACK_REASON = 'held back -- see the problems log';

export async function listSubfolders(dir: string): Promise<SubfolderListing> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skipped: SubfolderListing['skipped'] = [];
  for (const entry of entries) {
    if (entry.isFile() && clutterReason(entry.name) === null) {
      skipped.push({ file: entry.name, reason: LOOSE_FILE_REASON });
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

  // THE PROBLEMS LOG IS THE WHOLE ACCOUNT of what was left out and why: the
  // folders and files the listing refused are in it as well as what the sequence
  // check found, so an operator reading it needs no other list.
  const problems: FolderProblem[] = found.skipped.map(({ file, reason }) =>
    reason === LOOSE_FILE_REASON
      ? {
          folder: '',
          file,
          effect: 'held back' as const,
          problem: reason,
          fix: 'move it into the folder of the item it belongs to, or out of the batch folder',
        }
      : {
          folder: file,
          file: '',
          effect: 'held back' as const,
          problem: reason,
          fix: 'correct the folder, then build the spreadsheet again',
        },
  );

  const rule: SequenceRule = {
    patterns: profile.checks?.sequence?.patterns ?? [],
    labels: resolveLabels(profile.checks?.sequence?.labels),
  };
  const patterns = rule.patterns;
  let numbered = 0;
  // Every folder's group and years, held back or not, for the checks across
  // the run of groups (sequenceChecks.ts#checkBatch).
  const groups: GroupSummary[] = [];

  let done = 0;
  for (const folder of found.folders) {
    if (signal?.aborted) break;

    // CHECKED BEFORE ANYTHING IS READ: a folder held back costs no reading,
    // and is left out of the spreadsheet altogether -- which is what holds it
    // back, since `plan` then finds no row for it and says so.
    const findings =
      patterns.length === 0
        ? []
        : (() => {
            const group = folderGroup(profile.pattern, folder.name);
            const result = checkSequence(rule, group, folder.name, folder.files);
            numbered += result.numbered;
            groups.push({ folder: folder.name, group, years: result.years });
            return result.findings;
          })();
    problems.push(...findings.map((f) => ({ folder: folder.name, ...f })));
    if (findings.some((f) => f.effect === 'held back')) {
      skipped.push({ file: folder.name, reason: HELD_BACK_REASON });
      done += 1;
      onProgress?.(done, found.folders.length);
      continue;
    }

    // Read in ATTACHMENT order -- part order when the template declares it --
    // because "the first file that answers wins" means the first part.
    const order = orderBySequence(patterns, folder.files);
    const readable = new Set(folder.readable);
    const docs: FolderDoc[] = [];
    const unreadable: string[] = [];
    for (const name of order.filter((n) => readable.has(n))) {
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
    // The notes go on the row as well, so `_notes` and the log agree.
    row.notes.push(...findings.map((f) => (f.file === '' ? f.problem : `${f.file}: ${f.problem}`)));
    // RECORDED ONLY WHERE IT DIFFERS FROM NAME ORDER. Blank means name order,
    // so a folder that needs no cell gets none -- and a rename, the documented
    // remedy for an order, then takes effect instead of leaving a stale list
    // that plan must refuse. Every folder's order is still reviewed, and can be
    // changed, on the desktop Review screen.
    if (order.some((name, i) => name !== folder.files[i])) {
      // A name the cell cannot carry -- it splits on ';' and trims -- would be
      // refused by plan; say so here instead of writing a list that cannot work.
      const unwritable = order.filter((n) => n.includes(';') || n.trim() !== n);
      if (unwritable.length === 0) row.attachmentOrder = order;
      else {
        row.notes.push(
          `the order by ${rule.labels.part} could not be written to the 'attachment order' column, ` +
            `because ${unwritable.map((n) => `'${n}'`).join(', ')} contains ';' or starts or ends ` +
            `with a space; it will upload in name order unless the file is renamed, or the order ` +
            `is changed on the Review screen`,
        );
      }
    }
    rows.push(row);
    done += 1;
    onProgress?.(done, found.folders.length);
  }

  // Across the whole run: a missing group, two folders for one, dates that
  // run backwards from one group to the next. Notes for review, never holds.
  problems.push(...checkBatch(rule.labels, groups));

  // A check that matched nothing did not run, and must not read as clean --
  // the failure this codebase has had three times. Once, for the batch.
  if (patterns.length > 0 && found.folders.length > 0 && numbered === 0) {
    problems.push({
      folder: '',
      file: '',
      effect: 'note',
      problem: 'no file in the batch matched the sequence patterns, so the arrangement was not checked',
      fix: "compare the profile's checks.sequence.patterns with the file names",
    });
  }

  return { rows, skipped, problems };
}
