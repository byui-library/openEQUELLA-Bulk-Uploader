import type { OeqClient } from './client.js';
import type { Manifest, ManifestEntry, RowStatus } from './types.js';
import { ATTACHMENT_UUID_XPATH } from './types.js';
import { loadManifest, saveManifest } from './state.js';
import { buildMetadataXml } from './metadata.js';
import { uploadFile } from './upload.js';
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
}

export interface RunSummary {
  created: number;
  failed: number;
  skipped: number;
  /** Item + file were created, but its metadata's attachment uuid could not
   *  be verified to match what the server actually assigned. See
   *  `processEntry` below -- this is intentionally never retried. */
  incomplete: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isRetryable = (err: unknown): boolean => (err instanceof ApiError ? err.retryable : false);

/**
 * Statuses that mean "this row's item already exists (or was deliberately
 * left alone) and must never be reprocessed automatically". Reprocessing any
 * of these would call `uploadFile`/`createItem` again against a row that
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
  return `Row ${entry.rowNumber} (${entry.fileName})`;
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
 * ---- Attachment uuid verification ----
 * The attachment uuid is generated here, client-side, so it can be embedded
 * in `ATTACHMENT_UUID_XPATH` and sent in the *same* `createItem` request
 * that also declares the attachment -- avoiding a second round trip to patch
 * the metadata after the fact. `client.ts` flags this as an unverified
 * assumption: "VERIFY the server honours a supplied uuid". If it doesn't --
 * if openEQUELLA silently assigns its own uuid instead of the one we asked
 * for -- then the metadata XML already sent to the server (and now baked
 * into the item) references a uuid that does not match the item's actual
 * attachment. Reporting that row as `created` would hide a real, silent data
 * problem behind a success status. Instead this compares the uuid the
 * server echoes back (`result.attachmentUuids[0]`) against the one we asked
 * for; a mismatch marks the row `incomplete` (a status that exists for
 * exactly this) with an explanation, and -- critically -- does NOT throw,
 * so the caller's retry loop does not attempt this row again. The item and
 * its file attachment already exist on the server at this point; retrying
 * would create a second, duplicate item rather than fixing anything.
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
  const stagingUuid = await uploadFile(client, entry.filePath, entry.fileName);

  const attachmentUuid = randomUUID();
  const metadata = {
    ...entry.metadata,
    [ATTACHMENT_UUID_XPATH]: [attachmentUuid],
  };

  const result = await client.createItem({
    collectionUuid: manifest.collectionUuid,
    metadata: buildMetadataXml(metadata),
    stagingUuid,
    attachments: [{ filename: entry.fileName, description: entry.fileName, uuid: attachmentUuid }],
    draft: manifest.itemState === 'draft',
  });

  entry.itemUuid = result.uuid;
  entry.itemVersion = result.version;

  const actualUuid = result.attachmentUuids[0];
  if (actualUuid !== undefined && actualUuid !== attachmentUuid) {
    entry.attachmentUuid = actualUuid;
    entry.status = 'incomplete';
    entry.error =
      `${rowContext(entry)}: item ${result.uuid} and its attachment were created, but ` +
      `openEQUELLA assigned attachment uuid '${actualUuid}' instead of the requested ` +
      `'${attachmentUuid}'. The metadata already sent to the server still references the ` +
      `requested uuid, so '${ATTACHMENT_UUID_XPATH}' is now stale on this item. This needs ` +
      `manual correction in openEQUELLA -- do not re-run this row, it would create a ` +
      `duplicate item.`;
    return 'incomplete';
  }

  entry.attachmentUuid = actualUuid ?? attachmentUuid;
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
    const summary: RunSummary = { created: 0, failed: 0, skipped: 0, incomplete: 0 };
    const total = manifest.entries.length;
    let done = 0;

    for (const entry of manifest.entries) {
      done++;

      if (TERMINAL_STATUSES.has(entry.status)) {
        summary.skipped++;
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
