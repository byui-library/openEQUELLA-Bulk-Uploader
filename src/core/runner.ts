import type { OeqClient } from './client.js';
import { rowLabel, type Manifest, type ManifestEntry, type RowStatus } from './types.js';
import { loadManifest, saveManifest } from './state.js';
import { buildMetadataXml } from './metadata.js';
import { uploadFiles } from './upload.js';
import { ApiError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { acquireLock, releaseLock } from './lock.js';

/** Re-exported so callers (the MCP server, Task 12) need only import from
 *  runner.ts to check whether a run is currently in progress. */
export { checkLock } from './lock.js';

export interface RunOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Invoked after each entry so front ends can report progress. */
  onProgress?: (entry: ManifestEntry, done: number, total: number) => void;
  /**
   * Process entries that were found in `'uploading'` state at load time
   * (leftovers from an interrupted prior run) instead of skipping them. Off
   * by default: see the "interrupted-at-load" handling in `runManifest` for
   * why this must be an explicit operator opt-in, never automatic.
   */
  forceInterrupted?: boolean;
}

export interface RunSummary {
  created: number;
  failed: number;
  skipped: number;
  /** Item + file were created, but its metadata's attachment uuid could not
   *  be verified to match what the server actually assigned. See
   *  `processEntry` below -- this is intentionally never retried. */
  incomplete: number;
  /**
   * Entries found `'uploading'` at load time -- leftovers from a run that
   * was interrupted mid-row (crash, kill, disk full, laptop sleep) -- and
   * therefore left unprocessed rather than guessed at. See `runManifest`.
   * A CLI should surface this count prominently: it means "go check the
   * collection by hand", not "everything's fine".
   */
  interrupted: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isRetryable = (err: unknown): boolean => (err instanceof ApiError ? err.retryable : false);

/**
 * Statuses that mean "this row's item already exists (or was deliberately
 * left alone) and must never be reprocessed automatically". Reprocessing any
 * of these would call `uploadFiles`/`createItem` again against a row that
 * already produced a real openEQUELLA item, creating a duplicate
 * contribution -- exactly the failure mode the manifest/resume design exists
 * to prevent.
 *
 * `failed` is deliberately NOT in this set: a failed row never got an item
 * created, so re-attempting it on a plain resume is safe, and is what lets
 * `runManifest` be re-invoked (e.g. after fixing a transient network issue)
 * without requiring the operator to first call the explicit
 * `oeq_retry_failed` reset. That tool remains useful for a different reason:
 * it resets `entry.attempts` back to 0, giving a chronically-failing row a
 * fresh `maxAttempts` budget instead of the cumulative counter it would
 * otherwise keep climbing under here.
 */
const TERMINAL_STATUSES: ReadonlySet<RowStatus> = new Set(['created', 'skipped', 'incomplete']);

/** `Row 14 (Sears, Rivka 072126.MP4)` -- prefix for every error this runner records. */
function rowContext(entry: ManifestEntry): string {
  return `Row ${entry.rowNumber} (${rowLabel(entry)})`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs one entry through upload + item creation, mutating it in place to
 * record the outcome. Returns the terminal status reached on SUCCESS
 * (`created` or `incomplete`); throws on a genuine failure so the caller's
 * retry loop can decide whether to retry.
 *
 * A row carries one file or a whole folder's worth; either way it becomes ONE
 * item, with one attachment per file in `entry.files` order.
 *
 * ---- Attachment uuid verification ----
 * The attachment uuids are generated here, client-side, so they can be
 * embedded in `manifest.attachmentUuidPath` and sent in the *same*
 * `createItem` request that also declares the attachments -- avoiding a
 * second round trip to patch the metadata after the fact. If openEQUELLA
 * silently assigned its own uuids instead of the ones we asked for, the
 * metadata XML already sent to the server (and now baked into the item)
 * would reference uuids that do not match the item's actual attachments.
 * Reporting that row as `created` would hide a real, silent data problem
 * behind a success status. Instead this compares the uuids the server echoes
 * back against the ones we asked for, position by position; a mismatch
 * marks the row `incomplete` (a status that exists for
 * exactly this) with an explanation, and -- critically -- does NOT throw,
 * so the caller's retry loop does not attempt this row again. The item and
 * its file attachment already exist on the server at this point; retrying
 * would create a second, duplicate item rather than fixing anything.
 *
 * THAT REASONING ONLY HOLDS WHEN THE FIELD WAS WRITTEN. With no
 * `attachmentUuidPath` configured (the default -- most schemas declare no
 * such node, see types.ts) nothing in the item references the uuid we asked
 * for, so a server-assigned one leaves nothing stale: the item and its
 * attachment are both correct and the row is simply `created`. Marking it
 * `incomplete` would report a healthy row as broken and send the operator
 * into openEQUELLA to hand-correct a field that isn't there.
 *
 * If the server's response omits attachment uuids entirely (an empty/absent
 * array), there is nothing to compare against, so the row is trusted and
 * reported as `created` using the uuid we supplied.
 */
async function processEntry(
  client: OeqClient,
  manifest: Manifest,
  entry: ManifestEntry,
): Promise<'created' | 'incomplete'> {
  const stagingUuid = await uploadFiles(client, entry);

  // One client uuid per file, in upload order. openEQUELLA keeps both the
  // order and the uuids it is sent -- proven live on 2026-11-11.
  const attachments = entry.files.map((f) => ({
    filename: f.name,
    description: f.name,
    uuid: randomUUID(),
  }));
  const requested = attachments.map((a) => a.uuid);
  // Spread only when a path is configured: an unset path must leave NO trace
  // in the document, not an empty element or a placeholder under some
  // fallback name. Every uuid goes in, in order -- one element each.
  const uuidPath = manifest.attachmentUuidPath ?? '';
  const metadata =
    uuidPath === '' ? entry.metadata : { ...entry.metadata, [uuidPath]: requested };

  const result = await client.createItem({
    collectionUuid: manifest.collectionUuid,
    metadata: buildMetadataXml(metadata),
    stagingUuid,
    attachments,
    draft: manifest.itemState === 'draft',
  });

  entry.itemUuid = result.uuid;
  entry.itemVersion = result.version;

  // Compared POSITION BY POSITION wherever the server returns any. The
  // metadata lists the uuids in order, so even the same set in a different
  // order would leave it describing the wrong files. The live server returns
  // none at all (Location only), which is trusted below.
  const returned = result.attachmentUuids;

  // A COUNT THAT DIFFERS IS A MISSING FILE, whatever is configured. Unlike a
  // uuid the server chose itself -- which only matters when the metadata
  // records uuids -- an attachment fewer than was sent means the item does not
  // hold everything the plan said it would, and an item missing an issue reads
  // as complete to everyone who finds it later. Never retried: the item exists.
  if (returned.length > 0 && returned.length !== requested.length) {
    entry.attachmentUuids = returned;
    entry.status = 'incomplete';
    entry.error =
      `${rowContext(entry)}: item ${result.uuid} was created, but openEQUELLA reported ` +
      `${returned.length} attachment(s) on the item, but ${requested.length} file(s) were sent. ` +
      `Check the item in openEQUELLA for the missing files -- do not re-run this row, it would ` +
      `create a duplicate item.`;
    return 'incomplete';
  }

  const differs =
    returned.length > 0 &&
    (returned.length !== requested.length || requested.some((u, i) => returned[i] !== u));
  if (uuidPath !== '' && differs) {
    entry.attachmentUuids = returned;
    entry.status = 'incomplete';
    entry.error =
      `${rowContext(entry)}: item ${result.uuid} and its ${requested.length === 1 ? 'attachment was' : 'attachments were'} ` +
      `created, but openEQUELLA assigned attachment uuid(s) [${returned.join(', ')}] instead of ` +
      `the requested [${requested.join(', ')}]. The metadata already sent to the server still ` +
      `references the requested uuid(s), so '${uuidPath}' is now stale on this item. This needs ` +
      `manual correction in openEQUELLA -- do not re-run this row, it would create a ` +
      `duplicate item.`;
    return 'incomplete';
  }

  entry.attachmentUuids = returned.length > 0 ? returned : requested;
  entry.status = 'created';
  delete entry.error;
  return 'created';
}

/**
 * Walk a job manifest end to end: sequential, per-row isolated, resumable.
 * Never prompts -- every ambiguity was resolved at plan time. Safe to
 * re-invoke against the same manifest; rows already `created`, `skipped`, or
 * `incomplete` are left untouched (see `TERMINAL_STATUSES`).
 *
 * ---- Interrupted-at-load handling ----
 * Every row is saved as `'uploading'` just before `processEntry` runs (see
 * the loop below), specifically so an interrupted run leaves visible
 * evidence behind. If the process dies after `createItem` actually
 * succeeded server-side but before the trailing `saveManifest` after it
 * lands -- a crash, a kill, a full disk, a laptop going to sleep mid-upload,
 * any ordinary interruption -- the on-disk entry is left stuck at
 * `'uploading'` with no way for this code to tell whether the item exists
 * or not.
 *
 * `RowStatus` has no dedicated "interrupted" value (it's fixed in
 * types.ts), and no legitimate run ever produces a persisted `'uploading'`
 * entry on its own -- that status only ever exists transiently in memory
 * while a row is actively being processed within a single call. So any
 * entry found `'uploading'` *at the moment the manifest is loaded* is
 * unambiguous evidence of exactly this interruption, and is captured once,
 * up front, into `interruptedAtLoad` below -- a genuine one-time load-time
 * scan, not a per-iteration `entry.status` check, so the entries this run
 * itself transitions through `'uploading'` on the way to `'created'` are
 * never mistaken for leftovers of a *previous* run.
 *
 * Reprocessing a row in that state blind would re-upload the file and
 * create a second item -- a silent duplicate ~150 MB contribution in a
 * collection with no moderation queue to catch it. Skipping it costs
 * nothing worse than a re-run after the operator manually checks the
 * collection. That asymmetry is why the default is to skip: guessing wrong
 * in the "process it" direction is expensive and hard to undo; guessing
 * wrong in the "skip it" direction is cheap. `opts.forceInterrupted` is the
 * operator's explicit override once they've checked and confirmed it's
 * safe to retry.
 *
 * Guarded by a `<manifestPath>.lock` file for the duration of the run (see
 * lock.ts) so a concurrently-invoked `oeq_plan`/`oeq_retry_failed`/CLI
 * `retry` can detect a run in progress instead of silently clobbering its
 * progress with a stale in-memory snapshot.
 */
export async function runManifest(
  client: OeqClient,
  manifestPath: string,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 2000;

  await acquireLock(manifestPath);
  try {
    const manifest = await loadManifest(manifestPath);
    const summary: RunSummary = { created: 0, failed: 0, skipped: 0, incomplete: 0, interrupted: 0 };
    const total = manifest.entries.length;
    let done = 0;

    // One-time scan, taken before any entry in *this* run is touched. See
    // the "Interrupted-at-load handling" doc comment above.
    const interruptedAtLoad = new Set(
      manifest.entries.filter((e) => e.status === 'uploading'),
    );

    for (const entry of manifest.entries) {
      done++;

      if (TERMINAL_STATUSES.has(entry.status)) {
        summary.skipped++;
        reportProgress(opts, entry, done, total);
        continue;
      }

      if (interruptedAtLoad.has(entry) && !opts.forceInterrupted) {
        entry.error =
          `${rowContext(entry)}: a previous run was interrupted while processing this row. ` +
          `The item may or may not have been created. Check the collection for it before ` +
          `retrying; use --force-interrupted to process it anyway.`;
        await saveManifest(manifestPath, manifest);
        summary.interrupted++;
        reportProgress(opts, entry, done, total);
        continue;
      }

      let lastError: unknown;
      let outcome: 'created' | 'incomplete' | undefined;
      // `attempt` bounds this single runManifest() invocation only.
      // `entry.attempts` (incremented below) is a separate, cumulative
      // counter that survives across resumed runs (see types.ts) -- an
      // entry resumed after e.g. 5 prior attempts must still get a full
      // `maxAttempts` budget here, not be measured against its lifetime total.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        entry.attempts++;
        entry.status = 'uploading';
        await saveManifest(manifestPath, manifest);
        try {
          outcome = await processEntry(client, manifest, entry);
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          if (!isRetryable(err) || attempt === maxAttempts) break;
          // Exponential backoff: transient server pressure needs room to clear.
          await sleep(retryDelayMs * 2 ** (attempt - 1));
        }
      }

      if (lastError) {
        entry.status = 'failed';
        entry.error = `${rowContext(entry)}: ${describeError(lastError)}`;
        summary.failed++;
      } else if (outcome === 'incomplete') {
        summary.incomplete++;
      } else {
        summary.created++;
      }

      await saveManifest(manifestPath, manifest);
      reportProgress(opts, entry, done, total);
    }

    return summary;
  } finally {
    await releaseLock(manifestPath);
  }
}

/**
 * A caller-supplied progress callback (e.g. a CLI's terminal renderer) is
 * best-effort reporting, not part of the upload's correctness. A bug in it
 * (a formatting error, say) must never take down an otherwise-healthy batch
 * partway through a multi-GB run.
 */
function reportProgress(
  opts: RunOptions,
  entry: ManifestEntry,
  done: number,
  total: number,
): void {
  try {
    opts.onProgress?.(entry, done, total);
  } catch {
    // Swallowed deliberately -- see doc comment above.
  }
}
