import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { ApiError, ValidationError } from './errors.js';
import type { OeqClient } from './client.js';

/**
 * Upload one file into a fresh staging area and return that area's uuid.
 *
 * The file is streamed rather than buffered: at ~150 MB per file, buffering
 * would cost heap for no gain. On failure the staging area is removed so a
 * retry does not leak a partial upload server-side.
 *
 * ---- The 401-mid-upload gap ----
 * `OeqClient.request()` retries once on 401 after invalidating the token,
 * but it deliberately refuses to do so when the body is a stream: a drained
 * stream re-sent as-is would silently become a 0-byte upload. Instead it
 * invalidates the token and throws `ApiError(401)`, which `ApiError.retryable`
 * reports as `false` -- the runner (Task 10) will not retry it either.
 *
 * That would permanently fail a row every time its token happens to expire
 * mid-upload, even though the token has already been invalidated by the
 * time the error reaches here and an immediate retry would succeed. This
 * module is the layer that owns "how do I get a fresh body" (it's the one
 * that opened the file in the first place), so it is responsible for
 * closing that gap: on a 401, delete the now-orphaned staging area, create
 * a new one, open a brand-new read stream from disk, and try exactly once
 * more. If the retry also 401s, that's let propagate -- two expiries in a
 * row within a single upload is treated as a genuine auth problem, not
 * something to hammer forever.
 */
export async function uploadFile(
  client: OeqClient,
  filePath: string,
  fileName: string,
): Promise<string> {
  return uploadOnce(client, filePath, fileName, false);
}

async function uploadOnce(
  client: OeqClient,
  filePath: string,
  fileName: string,
  isRetry: boolean,
): Promise<string> {
  const stagingUuid = await client.createStagingArea();
  try {
    // Both checked inside the same try as the upload itself, so a missing
    // file, a 0-byte file, and a genuine upload failure all funnel through
    // the one cleanup path below rather than three separately-maintained
    // ones. This matters because a missing/unreadable file does NOT fail
    // synchronously here: `createReadStream` never throws for ENOENT --
    // the error only surfaces later as an 'error' event on the stream,
    // discovered when `fetch` tries to pump the body, which rejects the
    // `uploadToStaging` promise asynchronously. Pre-flighting with `stat`
    // catches the common case earlier (before spending a request attempting
    // to stream a file that isn't there), but does not remove the need for
    // the catch below: `stat` and the stream open are not atomic, so a file
    // that vanishes or becomes unreadable in that window still fails via
    // the stream's error event, and must still result in the staging area
    // being deleted -- which the shared catch below guarantees regardless
    // of which of the two ways the failure arrived.
    const stats = await stat(filePath);
    // A 1 media file : 1 attachment contract makes a 0-byte source file a
    // real hazard: it would "succeed" and silently create an empty
    // attachment on the item rather than surfacing as a problem. A 0-byte
    // file is essentially always evidence of a broken export/copy upstream,
    // never an intentional empty attachment, so this rejects loudly instead
    // of producing a silently-broken item.
    if (stats.size === 0) {
      throw new ValidationError(`Refusing to upload '${filePath}': the file is 0 bytes.`);
    }
    await client.uploadToStaging(stagingUuid, fileName, openAsBody(filePath));
    return stagingUuid;
  } catch (err) {
    await client.deleteStagingArea(stagingUuid);
    // Only recover once: the client has already invalidated the token by
    // the time it throws this, so a fresh attempt gets a new one. A second
    // 401 in a row is treated as a real auth failure and propagates.
    if (!isRetry && err instanceof ApiError && err.status === 401) {
      return uploadOnce(client, filePath, fileName, true);
    }
    throw err;
  }
}

/**
 * `Readable.toWeb()` returns a `ReadableStream` from `node:stream/web`.
 * The global `ReadableStream` type that `fetch`'s `BodyInit` is declared
 * against (via lib.dom.d.ts) is a *structurally* near-identical but
 * nominally distinct type -- they diverge only in the generic variance of
 * a couple of reader-related method signatures, not in anything that
 * affects what actually gets sent over the wire. Both describe the same
 * WHATWG Streams object at runtime; the mismatch is purely a TypeScript
 * ambient-lib artifact of this project having no "dom" lib. A direct cast
 * (not `as any`/`as unknown as ...`) still keeps the rest of the object
 * shape checked, so it's an accurate, narrow correction rather than an
 * escape hatch.
 */
function openAsBody(filePath: string): ReadableStream {
  return Readable.toWeb(createReadStream(filePath)) as ReadableStream;
}
