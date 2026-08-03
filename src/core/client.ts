/**
 * openEQUELLA REST client.
 *
 * ============================ UNVERIFIED CONTRACT ============================
 * We have not been able to fetch `schema/swagger.json` from the live instance
 * (blocked on a `VIEW_APIDOCS` privilege we could not confirm we hold — see
 * CLAUDE.md, "Working notes"). Every endpoint path, payload field name, and
 * status code below is therefore an ASSUMPTION, carried over from
 * openEQUELLA's general REST API rather than confirmed against
 * `content.byui.edu`. Specifically, this file assumes:
 *
 *   - POST   /oauth/access_token           issues a token consumed as
 *            `X-Authorization: access_token=...` (see auth.ts).
 *   - POST   /api/staging                  -> 201 { uuid } for a new staging area.
 *   - PUT    /api/staging/:uuid/:filename  accepts a raw file body, no wrapper JSON.
 *   - DELETE /api/staging/:uuid            discards a staging area.
 *   - POST   /api/item?draft=<bool>        body:
 *              { collection: { uuid }, metadata, stagingUuid,
 *                attachments: [{ type: "file", filename, description, uuid? }] }
 *            -> 201 { uuid, version, attachments: [{ uuid }] }.
 *            Assumed: `draft` query param (not a body field) toggles
 *            draft vs. published; a client-supplied attachment `uuid` is
 *            honoured rather than always server-generated.
 *            DANGER — assumed FAIL-OPEN TOWARD PUBLISHED: the assumed check
 *            is `draft === 'true'` (exact string match), so a missing,
 *            empty, malformed, or otherwise-not-literally-'true' value is
 *            assumed to mean PUBLISHED, not draft. There is no server-side
 *            safety net for this collection. `createItem` below therefore
 *            runtime-checks `req.draft` is a genuine boolean and refuses to
 *            send the request otherwise — verify this assumption FIRST
 *            against swagger.json before ever relaxing that guard.
 *   - GET    /api/search?collections=&q=&length= -> 200 { available, results }.
 *            Assumed: `q` performs *some* text match; whether it is an exact
 *            phrase match or a free-text/OR-of-terms match is UNVERIFIED
 *            (see the caveat on identifierExists() below).
 *
 * `tests/helpers/mockServer.ts` encodes this exact same assumed contract.
 * When `schema/swagger.json` is finally captured (or the live API responds
 * differently in practice), THIS FILE and mockServer.ts are the only two
 * files that should need to change to reconcile the difference — every other
 * module (upload orchestration, the runner, the CLI) depends only on this
 * client's TypeScript interface, never on the wire format directly.
 * ===============================================================================
 */
import type { AuthProvider } from './auth.js';
import { ApiError, ValidationError } from './errors.js';

export interface AttachmentSpec {
  filename: string;
  description: string;
  /** Client-supplied uuid. VERIFY the server honours this. */
  uuid?: string;
}

export interface CreateItemRequest {
  collectionUuid: string;
  metadata: string;
  stagingUuid: string;
  attachments: AttachmentSpec[];
  draft: boolean;
}

export interface CreateItemResult {
  uuid: string;
  version: number;
  attachmentUuids: string[];
}

/**
 * Body types fetch() can safely re-send on a retry: their content is held in
 * memory (or is otherwise re-readable) rather than drained by the act of
 * sending the first request. Anything else (a web ReadableStream, a Node
 * Readable, a bare async iterable) is a one-shot: by the time a response
 * comes back, the underlying HTTP client has already pulled it dry, so
 * re-issuing the same `init` would silently send an empty body. Task 9's
 * ~150MB uploads will pass exactly this kind of stream as `body`.
 */
function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body == null) return true;
  if (typeof body === 'string') return true;
  if (body instanceof Blob) return true;
  if (body instanceof URLSearchParams) return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  return false;
}

export class OeqClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: AuthProvider,
  ) {}

  /**
   * Single request path for every call. Retries exactly once on 401 after
   * invalidating the token — a long batch will outlive its access token.
   *
   * On the retried 401 (i.e. the retry itself also comes back 401), this
   * throws an ApiError with status 401 and gives up: ApiError.retryable is
   * false for 401 by design (see errors.ts), so a caller-level retry loop
   * (Task 10's runner) will not hammer a genuinely-bad credential 3 more
   * times per row across dozens of rows.
   *
   * Row/operation context (e.g. "row 14: ...") is deliberately NOT attached
   * to these error messages here. This client has no notion of "rows" — it
   * is a plain per-request REST wrapper reused by staging, item-creation and
   * search calls alike, and threading a "current row" through every method
   * signature would leak orchestration concerns into a module that should
   * stay agnostic of them. The runner (Task 10), which is the only layer
   * that knows which row triggered a given call, is responsible for
   * annotating/wrapping a caught ApiError with that context before logging
   * or reporting it.
   */
  private async request(
    path: string,
    init: RequestInit = {},
    retriedAfter401 = false,
  ): Promise<Response> {
    const method = init.method ?? 'GET';
    // Constructed outside the try/catch below: a malformed path/baseUrl is a
    // programming bug, not a network failure, and must not be reported as a
    // retryable ApiError(status 0) -- that would tell a caller to retry an
    // error that will never succeed no matter how many times it's retried.
    const url = new URL(path, this.baseUrl);
    const headers = { ...(init.headers ?? {}), ...(await this.auth.authHeader()) };

    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (cause) {
      // Network-level failure (DNS, connection reset, etc.) never reaches a
      // status code. Model it as ApiError status 0, matching auth.ts's
      // convention, so `.retryable` (which treats 0 as transient) applies
      // uniformly here too.
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ApiError(
        `${method} ${path} failed before a response was received: ${detail}`,
        0,
        '',
      );
    }

    if (res.status === 401 && !retriedAfter401) {
      if (!isReplayableBody(init.body)) {
        this.auth.invalidate();
        throw new ApiError(
          `${method} ${path} received 401 (token likely expired) and cannot be ` +
            `safely retried automatically: its request body is a one-shot stream ` +
            `that has already been consumed. Re-run this operation from scratch ` +
            `(e.g. re-open the source file) so a fresh body can be sent.`,
          401,
          await res.text().catch(() => ''),
        );
      }
      this.auth.invalidate();
      return this.request(path, init, true);
    }
    if (!res.ok) {
      throw new ApiError(`${method} ${path} failed`, res.status, await res.text());
    }
    return res;
  }

  async createStagingArea(): Promise<string> {
    const res = await this.request('/api/staging', { method: 'POST' });
    const { uuid } = (await res.json()) as { uuid: string };
    return uuid;
  }

  /**
   * Best-effort cleanup; a leaked staging area must never fail the row. Only
   * an ApiError (an actual failed HTTP call — 404, 5xx, network error, the
   * non-replayable-body guard above, etc.) is swallowed here. Anything else
   * — a TypeError from a programming mistake, for instance — is a bug, not a
   * cleanup failure, and is allowed to propagate rather than vanish silently.
   */
  async deleteStagingArea(uuid: string): Promise<void> {
    try {
      await this.request(`/api/staging/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }

  async uploadToStaging(stagingUuid: string, filename: string, body: BodyInit): Promise<void> {
    await this.request(
      `/api/staging/${encodeURIComponent(stagingUuid)}/${encodeURIComponent(filename)}`,
      {
        method: 'PUT',
        body,
        headers: { 'content-type': 'application/octet-stream' },
        // @ts-expect-error Node-only: required when streaming a request body.
        duplex: 'half',
      },
    );
  }

  async createItem(req: CreateItemRequest): Promise<CreateItemResult> {
    // Runtime guard, not just the CreateItemRequest['draft']: boolean compile-time
    // type. Task 10's runner reads itemState back out of a JSON manifest on
    // disk -- hand-editable, possibly from an older tool version, possibly
    // partially written -- and TypeScript cannot protect a value that enters
    // the program as JSON. Given the assumed contract fails open toward
    // PUBLISHED (see header comment), refuse anything that isn't an
    // explicit boolean rather than let `String(req.draft)` coerce it into
    // something that isn't the literal string 'true' and isn't the literal
    // string 'false' either -- e.g. String(undefined) === 'undefined'.
    if (typeof req.draft !== 'boolean') {
      throw new ValidationError(
        `createItem: 'draft' must be an explicit boolean, got ${typeof req.draft}. ` +
          `Refusing to send an ambiguous value: the assumed server contract treats ` +
          `anything other than the exact string 'true' as publish-live, and this ` +
          `collection has no moderation workflow to catch the mistake.`,
      );
    }
    const res = await this.request(`/api/item?draft=${String(req.draft)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: { uuid: req.collectionUuid },
        metadata: req.metadata,
        stagingUuid: req.stagingUuid,
        attachments: req.attachments.map((a) => ({
          type: 'file',
          filename: a.filename,
          description: a.description,
          ...(a.uuid ? { uuid: a.uuid } : {}),
        })),
      }),
    });
    const body = (await res.json()) as {
      uuid: string;
      version: number;
      attachments?: { uuid: string }[];
    };
    return {
      uuid: body.uuid,
      version: body.version,
      attachmentUuids: (body.attachments ?? []).map((a) => a.uuid),
    };
  }

  /**
   * Advisory only — a hit is a question for the operator, never a silent
   * skip.
   *
   * LIMITATION (unverified wire format, see header): this sends the
   * identifier as a quoted phrase (`"..."`) hoping the server treats it as an
   * exact-phrase match, but whether `/api/search`'s `q` parameter actually
   * honours phrase quoting or instead does free-text/OR-of-terms matching is
   * UNCONFIRMED. If it's the latter, a search for `"Arnett, Erin
   * 072126.MP4"` could match unrelated items that merely share a word (e.g.
   * another "Erin" or another ".MP4" filename token), producing a false
   * positive. That is an acceptable failure mode ONLY because the result is
   * advisory and reviewed by a human, never used to auto-skip a row; a false
   * negative (missing a real duplicate) is a bigger concern than a false
   * positive here, and neither is fatal since a human sees it either way.
   */
  async identifierExists(collectionUuid: string, identifier: string): Promise<boolean> {
    const url =
      `/api/search?collections=${encodeURIComponent(collectionUuid)}` +
      `&q=${encodeURIComponent(`"${identifier}"`)}&length=1`;
    const res = await this.request(url);
    const body = (await res.json()) as { available: number };
    return body.available > 0;
  }
}
