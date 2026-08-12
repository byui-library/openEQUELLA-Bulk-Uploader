import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Manifest, ManifestEntry, Sheet, ItemState } from './types.js';
import { splitRepeatable } from './metadata.js';
import { ATTACHMENT_COLUMN } from './types.js';
import { validateHeaders, isAnnotationHeader } from './schema.js';
import { ValidationError } from './errors.js';
import type { OeqClient } from './client.js';

export interface PlanOptions {
  baseUrl: string;
  collectionUuid: string;
  schemaUuid: string;
  itemState: ItemState;
  /**
   * Metadata xpath the runner will fill with the real attachment uuid, or
   * empty/absent for "no such field" (the default -- see config.ts). When set,
   * a spreadsheet cell under that header is dropped here rather than carried
   * through: incoming spreadsheets put the FILENAME in that column and the
   * runner substitutes the uuid. When unset, nothing is reserved and the
   * header is an ordinary column like any other.
   */
  attachmentUuidPath?: string;
}

/**
 * Build the run manifest: match spreadsheet rows to files on disk, carry
 * metadata through, and surface every human-relevant discrepancy as either a
 * hard failure (something ambiguous or almost-certainly-a-mistake, caught
 * here rather than after 5.5 GB has started moving) or a warning (something
 * real but non-fatal that a human should still see before confirming the
 * run). This function never touches the network -- only the filesystem and
 * the in-memory sheet/schema.
 */
export async function buildManifest(
  sheet: Sheet,
  filesDir: string,
  schemaPaths: Set<string>,
  opts: PlanOptions,
): Promise<Manifest> {
  const attachmentUuidPath = opts.attachmentUuidPath ?? '';

  // Headers first: a typo should surface before we touch the filesystem.
  const { invalid } = validateHeaders(sheet.headers, schemaPaths);
  if (invalid.length > 0) {
    const detail = invalid
      .map((i) =>
        i.suggestions.length > 0
          ? `  '${i.header}' is not a valid xpath. Did you mean: ${i.suggestions.join(', ')}?`
          : `  '${i.header}' is not a valid xpath.`,
      )
      .join('\n');
    throw new ValidationError(`Spreadsheet has invalid column headers:\n${detail}`);
  }

  // withFileTypes + isFile(): filesDir sits next to the batch spreadsheet
  // itself (and may contain other incidental subfolders); only regular files
  // are upload candidates. A directory entry must never be "matched" as an
  // attachment, nor generate a spurious "no matching row" warning.
  const dirEntries = await readdir(filesDir, { withFileTypes: true });
  const onDisk = dirEntries.filter((d) => d.isFile()).map((d) => d.name);
  const byLower = new Map(onDisk.map((f) => [f.toLowerCase(), f]));

  const entries: ManifestEntry[] = [];
  const warnings: string[] = [];
  // actual on-disk filename -> every row number that claimed it, so a
  // same-file conflict can be reported with full detail, not just "the first
  // one wins" (a silent choice here would be nondeterministic-by-row-order
  // and would drop data from whichever row lost).
  const claims = new Map<string, number[]>();

  for (const row of sheet.rows) {
    const wanted = (row.cells[ATTACHMENT_COLUMN] ?? '').trim();
    if (wanted === '') {
      warnings.push(`Row ${row.rowNumber}: no '${ATTACHMENT_COLUMN}' value; skipped.`);
      continue;
    }
    const actual = byLower.get(wanted.toLowerCase());
    if (!actual) {
      warnings.push(`Row ${row.rowNumber}: file '${wanted}' not found in ${filesDir}; skipped.`);
      continue;
    }

    const rowsForFile = claims.get(actual) ?? [];
    rowsForFile.push(row.rowNumber);
    claims.set(actual, rowsForFile);

    const metadata: Record<string, string[]> = {};
    for (const [header, value] of Object.entries(row.cells)) {
      if (header === ATTACHMENT_COLUMN) continue;
      // Filled in with the real uuid once the attachment exists -- but only
      // when a path is configured. The `!== ''` guard matters: without it, an
      // unconfigured batch would silently drop any column whose header is
      // itself blank, rather than reserving nothing at all.
      if (attachmentUuidPath !== '' && header === attachmentUuidPath) continue;
      // Annotations for the human reading the spreadsheet, not metadata.
      if (isAnnotationHeader(header)) continue;
      // A repeatable field holding several semicolon-separated values becomes
      // several XML elements rather than one containing semicolons. Only
      // fields the schema declares repeatable are affected -- see
      // metadata.ts#isRepeatable -- so a semicolon in a description or a
      // rights statement stays the punctuation it is.
      (metadata[header] ??= []).push(...splitRepeatable(header, value));
    }

    entries.push({
      rowNumber: row.rowNumber,
      // Resolved against the current cwd if filesDir isn't already absolute:
      // Task 10's runner reads these paths back out of job.json in a
      // different process, possibly with a different cwd, so a
      // cwd-relative path would silently fail to open there.
      filePath: resolve(filesDir, actual),
      fileName: actual,
      metadata,
      status: 'pending',
      attempts: 0,
    });
  }

  // Two rows claiming the same file would produce two contributions sharing
  // one attachment -- a direct violation of the one-file-per-contribution
  // rule this tool is built on. It's virtually always a spreadsheet mistake
  // (a duplicated row, or two rows differing only in case), never a
  // legitimate case of "upload this file twice". Silently picking a winner
  // would be nondeterministic (whichever row is processed first) and would
  // silently drop the loser's metadata; a warning-and-skip would silently
  // drop an entire row's worth of data the operator may not notice missing
  // until well after the run. This is cheap to catch now, while nothing has
  // moved, so it hard-fails the whole plan with every conflict listed at
  // once (not just the first) so one fix-and-rerun cycle catches them all.
  const conflicts = [...claims.entries()].filter(([, rows]) => rows.length > 1);
  if (conflicts.length > 0) {
    const detail = conflicts
      .map(([file, rows]) => `  '${file}' is claimed by rows ${rows.join(', ')}`)
      .join('\n');
    throw new ValidationError(
      `Multiple spreadsheet rows claim the same file; each file may back only one ` +
        `contribution:\n${detail}\nFix the '${ATTACHMENT_COLUMN}' column (or remove the ` +
        `duplicate row) and re-run.`,
    );
  }

  for (const f of onDisk) {
    if (!claims.has(f)) warnings.push(`File '${f}' has no matching row; not uploaded.`);
  }

  // An empty manifest means the runner would do nothing at all -- almost
  // certainly a wrong filesDir or a wrong 'attachment name' column, not a
  // genuine zero-file batch. The plan phase exists precisely to catch this
  // kind of mistake before Task 10's runner starts (and Task 10 never
  // prompts, so this is the only chance to catch it interactively). Throwing
  // here, with the collected warnings folded in, tells the operator exactly
  // which rows/files failed to match rather than leaving them to discover a
  // silent no-op after the fact.
  if (entries.length === 0) {
    const reason = warnings.length > 0 ? `\n${warnings.join('\n')}` : '';
    throw new ValidationError(
      `No rows matched any file in ${filesDir}; nothing to upload. Check the directory ` +
        `path and the '${ATTACHMENT_COLUMN}' column.${reason}`,
    );
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    collectionUuid: opts.collectionUuid,
    schemaUuid: opts.schemaUuid,
    itemState: opts.itemState,
    attachmentColumn: ATTACHMENT_COLUMN,
    attachmentUuidPath,
    entries,
    warnings,
  };
}

/**
 * Advisory pre-flight scan for identifiers that may already exist in the
 * target collection. Returns warnings only -- it never mutates `manifest`
 * and never removes/skips an entry. Whether a hit is a real duplicate is a
 * judgment call for the human reviewing the plan, not something this tool
 * should decide on their behalf (see OeqClient.identifierExists' own
 * caveat about the underlying search possibly being a loose match).
 *
 * A network/API failure for one entry is caught and turned into its own
 * warning rather than aborting the whole pre-flight: an unreachable server
 * (or a transient error) is not evidence of anything about the identifier,
 * and it must not block a plan that is otherwise ready to run.
 */
export async function preflightDuplicates(
  client: OeqClient,
  manifest: Manifest,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of manifest.entries) {
    // Not every batch populates MWDL/identifier; entries without one are
    // simply not checkable, and that's expected, not a problem to flag.
    const identifier = entry.metadata['MWDL/identifier']?.[0]?.trim();
    if (!identifier) continue;

    try {
      const exists = await client.identifierExists(manifest.collectionUuid, identifier);
      if (exists) {
        warnings.push(
          `Row ${entry.rowNumber}: an item with identifier '${identifier}' may already exist ` +
            `in the collection; verify before uploading '${entry.fileName}'.`,
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnings.push(
        `Row ${entry.rowNumber}: could not check whether identifier '${identifier}' already ` +
          `exists (${detail}); verify manually before uploading '${entry.fileName}'.`,
      );
    }
  }
  return warnings;
}

/**
 * Mark rows as skipped, with a reason, before the run starts.
 *
 * Needs no runner change: `skipped` is already in the runner's
 * TERMINAL_STATUSES, so it steps over these rows and counts them into its
 * `skipped` total exactly as it does for rows a previous run completed.
 *
 * Only `pending` rows are touched. Rewriting an already-`created` row to
 * skipped would erase the record that an item exists for it.
 */
export function markSkipped(
  manifest: Manifest,
  rowNumbers: readonly number[],
  reason: string,
): number {
  const wanted = new Set(rowNumbers);
  let marked = 0;
  for (const entry of manifest.entries) {
    if (!wanted.has(entry.rowNumber) || entry.status !== 'pending') continue;
    entry.status = 'skipped';
    entry.error = reason;
    marked++;
  }
  return marked;
}
