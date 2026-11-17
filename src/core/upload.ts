import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { ApiError, ValidationError } from './errors.js';
import { listFolderFiles } from './folderFiles.js';
import type { OeqClient } from './client.js';
import type { ManifestFile } from './types.js';

/**
 * What a row uploads. Structurally a subset of `ManifestEntry`, so the runner
 * passes an entry straight in.
 */
export interface UploadUnit {
  source: string;
  /** Set for a folder row: re-listed before anything is created. */
  folderPath?: string;
  /** In upload order. One for a file row. */
  files: ManifestFile[];
}

/**
 * Upload a row's files into ONE fresh staging area, in order, and return that
 * area's uuid. `createItem` then attaches every file in it to one item --
 * proven live on 2026-11-11: one staging area, several PUTs, one item, with
 * the attachments kept in the order sent.
 *
 * Nothing is created until `checkUnchanged` has passed. Each file is streamed
 * rather than buffered: at ~150 MB per file, buffering would cost heap for no
 * gain. On failure the staging area is removed so a retry does not leak a
 * partial upload server-side.
 *
 * ---- The 401-mid-upload gap ----
 * `OeqClient.request()` retries once on 401 after invalidating the token,
 * but it deliberately refuses to do so when the body is a stream: a drained
 * stream re-sent as-is would silently become a 0-byte upload. Instead it
 * invalidates the token and throws `ApiError(401)`, which `ApiError.retryable`
 * reports as `false` -- the runner will not retry it either.
 *
 * That would permanently fail a row every time its token happens to expire
 * mid-upload, even though the token has already been invalidated by the
 * time the error reaches here and an immediate retry would succeed. This
 * module is the layer that owns "how do I get a fresh body" (it's the one
 * that opened the files in the first place), so it is responsible for
 * closing that gap: on a 401, delete the now-orphaned staging area and
 * restart THE WHOLE ROW -- a new area, a brand-new read stream for every
 * file -- exactly once more. Not just the file that failed: the area holding
 * the earlier files is gone, and an item must never be created from a
 * partial set. If the retry also 401s, that's let propagate -- two expiries
 * within a single row is treated as a genuine auth problem, not something to
 * hammer forever.
 */
export async function uploadFiles(client: OeqClient, unit: UploadUnit): Promise<string> {
  await checkUnchanged(unit);
  return uploadOnce(client, unit.files, false);
}

/**
 * The row's files are still the ones that were planned, or a ValidationError
 * -- not retryable -- saying what changed.
 *
 * The plan the operator read IS the thing they approved. A file added,
 * removed or replaced since then makes a contribution nobody looked at, in a
 * collection that may have no moderation queue to catch it, so the row fails
 * and says to plan again rather than uploading whatever is there now.
 *
 * Checked before creating any staging area: a doomed row costs no POST and
 * no compensating DELETE. This does NOT make the later stream opens
 * infallible -- a file can still vanish in the window before uploadOnce()
 * opens it (createStagingArea() is a network round trip, which gives that
 * window real time to matter). That residual case is handled inside
 * uploadOnce()'s try/catch.
 */
export async function checkUnchanged(unit: UploadUnit): Promise<void> {
  if (unit.folderPath !== undefined) {
    const listing = await listFolderFiles(unit.folderPath);
    const now = new Map(listing.files.map((f) => [f.name, f.size]));
    const planned = new Set(unit.files.map((f) => f.name));
    const problems: string[] = [];
    // An emptied folder is reported below file by file ("is missing"), which
    // names what went; the refusal sentence would only repeat it vaguely.
    if (listing.refusal !== undefined && listing.files.length > 0) problems.push(listing.refusal);
    for (const f of unit.files) {
      const size = now.get(f.name);
      if (size === undefined) {
        problems.push(`'${f.name}' is missing`);
      } else if (f.size !== undefined && size !== f.size) {
        // f.size absent means a version that did not record sizes planned
        // this row (manifest v1); only presence can be checked for it. See
        // ManifestFile.size.
        problems.push(`'${f.name}' changed size (${f.size} bytes when planned, ${size} now)`);
      }
    }
    for (const name of now.keys()) {
      if (!planned.has(name)) problems.push(`'${name}' was added`);
    }
    if (problems.length > 0) {
      throw new ValidationError(
        `the folder changed since planning (${problems.join('; ')}); plan again`,
      );
    }
    // The listing above has just measured every file; one measurement, not two
    // that could disagree.
    for (const f of unit.files) refuseEmpty(f, now.get(f.name)!);
    return;
  }

  for (const f of unit.files) {
    const { size } = await stat(f.path);
    if (f.size !== undefined && size !== f.size) {
      throw new ValidationError(
        `'${f.name}' changed since planning (${f.size} bytes when planned, ${size} now); plan again`,
      );
    }
    refuseEmpty(f, size);
  }
}

/**
 * A 0-byte source file is a hazard distinct from a missing one: it would
 * "succeed" and silently create an empty attachment rather than surfacing as
 * a problem. It is essentially always evidence of a broken export or copy
 * upstream, never an intentional empty attachment, so this rejects loudly
 * instead of producing a silently-broken item.
 */
function refuseEmpty(f: ManifestFile, size: number): void {
  if (size === 0) {
    throw new ValidationError(`Refusing to upload '${f.path}': the file is 0 bytes.`);
  }
}

async function uploadOnce(
  client: OeqClient,
  files: readonly ManifestFile[],
  isRetry: boolean,
): Promise<string> {
  const stagingUuid = await client.createStagingArea();
  for (const f of files) {
    // Captured as a named handle (rather than inlining `createReadStream(...)`
    // straight into the call below) specifically so the catch block can force
    // it closed on failure -- see the comment there. `createReadStream` never
    // throws synchronously for a missing/unreadable file; that failure only
    // surfaces later as an 'error' event on the stream, discovered when
    // `fetch` tries to pump it, which rejects `uploadToStaging`'s promise
    // asynchronously and is caught below same as any other upload failure.
    const nodeStream = createReadStream(f.path);
    try {
      // `Readable.toWeb()` returns a `ReadableStream` from `node:stream/web`.
      // The global `ReadableStream` that `fetch`'s `BodyInit` is declared
      // against (via lib.dom.d.ts) is a *structurally* near-identical but
      // nominally distinct type -- they diverge only in the generic variance
      // of a couple of reader-related method signatures, not in anything
      // that affects what's actually sent over the wire. A direct cast (not
      // `as any`/`as unknown as ...`) still keeps the rest of the object
      // shape checked, so it's an accurate, narrow correction rather than an
      // escape hatch.
      const body = Readable.toWeb(nodeStream) as ReadableStream;
      await client.uploadToStaging(stagingUuid, f.name, body);
    } catch (err) {
      // `client.request()` throws on a non-ok response (or a network
      // failure) without draining or closing whatever body it was given --
      // it has no way to know the body was backed by a file handle that
      // needs releasing. Left alone, a failed multi-hundred-MB upload leaks
      // that fd for the rest of the process's life. `.destroy()` is safe to
      // call even if the stream already ended or errored out on its own.
      nodeStream.destroy();
      await client.deleteStagingArea(stagingUuid);
      // Only recover once, and recover the WHOLE row: see uploadFiles. The
      // client has already invalidated the token by the time it throws this,
      // so a fresh attempt gets a new one.
      if (!isRetry && err instanceof ApiError && err.status === 401) {
        return uploadOnce(client, files, true);
      }
      throw err;
    }
  }
  return stagingUuid;
}
