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
  // Checked before creating any staging area: a missing or 0-byte file is
  // already known to be doomed without ever talking to the server, so
  // there's no reason to spend a POST (and then a compensating DELETE) on
  // it. This does NOT make the later stream open infallible -- the file
  // can still vanish or become unreadable in the window between this check
  // and uploadOnce() actually opening it (createStagingArea() below is a
  // network round trip, which gives that window real time to matter). That
  // residual case is handled inside uploadOnce()'s try/catch, which is
  // exercised by the "vanishes after the size check" test in
  // upload.test.ts.
  //
  // A 1 media file : 1 attachment contract makes a 0-byte source file a
  // real hazard in its own right, distinct from a missing one: it would
  // "succeed" and silently create an empty attachment on the item rather
  // than surfacing as a problem. A 0-byte file is essentially always
  // evidence of a broken export/copy upstream, never an intentional empty
  // attachment, so this rejects loudly instead of producing a
  // silently-broken item.
  const stats = await stat(filePath);
  if (stats.size === 0) {
    throw new ValidationError(`Refusing to upload '${filePath}': the file is 0 bytes.`);
  }

  return uploadOnce(client, filePath, fileName, false);
}

async function uploadOnce(
  client: OeqClient,
  filePath: string,
  fileName: string,
  isRetry: boolean,
): Promise<string> {
  const stagingUuid = await client.createStagingArea();
  // Captured as a named handle (rather than inlining `createReadStream(...)`
  // straight into the call below) specifically so the catch block can force
  // it closed on failure -- see the comment there. `createReadStream` never
  // throws synchronously for a missing/unreadable file; that failure only
  // surfaces later as an 'error' event on the stream, discovered when
  // `fetch` tries to pump it, which rejects `uploadToStaging`'s promise
  // asynchronously and is caught below same as any other upload failure.
  const nodeStream = createReadStream(filePath);
  try {
    // `Readable.toWeb()` returns a `ReadableStream` from `node:stream/web`.
    // The global `ReadableStream` that `fetch`'s `BodyInit` is declared
    // against (via lib.dom.d.ts) is a *structurally* near-identical but
    // nominally distinct type -- they diverge only in the generic variance
    // of a couple of reader-related method signatures, not in anything
    // that affects what's actually sent over the wire. Both describe the
    // same WHATWG Streams object at runtime; the mismatch is purely a
    // TypeScript ambient-lib artifact of this project having no "dom" lib.
    // A direct cast (not `as any`/`as unknown as ...`) still keeps the
    // rest of the object shape checked, so it's an accurate, narrow
    // correction rather than an escape hatch.
    const body = Readable.toWeb(nodeStream) as ReadableStream;
    await client.uploadToStaging(stagingUuid, fileName, body);
    return stagingUuid;
  } catch (err) {
    // `client.request()` throws on a non-ok response (or a network
    // failure) without draining or closing whatever body it was given --
    // it has no way to know the body was backed by a file handle that
    // needs releasing. Left alone, a failed multi-hundred-MB upload leaks
    // that fd for the rest of the process's life; at ~150 MB per file
    // across a batch of dozens, that adds up fast. `.destroy()` is safe to
    // call even if the stream already ended or errored out on its own.
    nodeStream.destroy();
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
