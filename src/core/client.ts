/**
 * openEQUELLA REST client.
 *
 * ============================ WIRE-FORMAT STATUS ============================
 * `schema/swagger.json` (Swagger 2.0, basePath `/api`, ~443KB) has since
 * arrived from the live instance. Below, CONFIRMED means checked directly
 * against that file; UNVERIFIED means still an assumption swagger.json does
 * not settle (it documents the declared contract, not a captured live
 * response — the two can still disagree).
 *
 * CONFIRMED against swagger.json:
 *   - POST /item takes `file` (the staging area id) and `draft` as QUERY
 *     PARAMS, not body fields. `ItemBean` (the documented body schema) has
 *     no staging/stagingUuid property at all — a server that followed this
 *     spec would have silently ignored a body-embedded `stagingUuid`,
 *     creating an item whose attachment points at a staging area the
 *     request never actually told the server about. Fixed here; see
 *     createItem() below.
 *   - `draft`'s documented default is `false` — omitting it means
 *     PUBLISHED. This confirms the runtime guard in createItem() (added
 *     defensively before swagger.json was available) was the right call,
 *     not overcaution.
 *   - GET /search has a `showall` query param (default `false`) described
 *     as "If true then includes items that are not live". Items here are
 *     created as drafts by default, i.e. not live — without `showall=true`,
 *     identifierExists() would never see the very items it exists to find,
 *     and a re-run would report "no duplicates" and recreate all of them.
 *     Fixed here; see identifierExists() below.
 *   - POST /item's only documented response is `default: successful
 *     operation` with NO response schema — the body shape is genuinely
 *     unspecified by the spec, not just uncaptured. openEQUELLA commonly
 *     returns 201 Created with an empty body and a `Location:
 *     /item/{uuid}/{version}` header in that situation. createItem() below
 *     now tolerates both a JSON body and a Location-only response rather
 *     than assuming either — treating an empty body as a parse failure
 *     would misreport a genuinely-created item as failed and cause a retry
 *     to create a duplicate.
 *   - `AttachmentBean` does have a `uuid` property, supporting the
 *     client-supplied attachment uuid this client relies on (see
 *     `AttachmentSpec.uuid`).
 *
 * STILL UNVERIFIED (swagger.json does not settle these):
 *   - `AttachmentBean`'s documented properties are `uuid, description,
 *     viewer, preview, erroredIndexing, restricted, externalId` — no
 *     `filename` or `type`. The spec does not model openEQUELLA's
 *     polymorphic attachment subtypes (file/url/etc.), so this client's
 *     `{ type: "file", filename, description, uuid? }` payload shape
 *     remains a guess. This is the next thing a live smoke test must check.
 *   - Whether `q` on /search performs an exact-phrase or free-text match
 *     (see the caveat on identifierExists() below) — swagger.json documents
 *     `q` only as "Query string", with no matching semantics specified.
 *   - POST /oauth/access_token — not an `/api`-basePath endpoint, so it is
 *     outside this swagger document entirely; still exactly as unverified
 *     as before (see auth.ts).
 *   - The staging-area endpoints this client assumes — POST /staging, PUT
 *     /staging/:uuid/:filename, DELETE /staging/:uuid — are NOT covered by
 *     this swagger.json review either: there is no "/staging" path in it at
 *     all. The document's only file-related paths are under
 *     `/file/{uuid}/...` (e.g. `/file/{uuid}/content/{filepath}`), which is
 *     a materially different shape than what's implemented below. This is
 *     a bigger discrepancy than a field name and needs its own dedicated
 *     verification pass — flagged, not fixed, in this change — before
 *     Task 9's upload path (upload.ts) should be trusted against the live
 *     server.
 *
 * `tests/helpers/mockServer.ts` encodes this exact same contract. When the
 * next discrepancy turns up, THIS FILE and mockServer.ts are the only two
 * files that should need to change to reconcile it — every other module
 * (upload orchestration, the runner, the CLI) depends only on this client's
 * TypeScript interface, never on the wire format directly.
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
    // `file` (the staging area id) and `draft` are QUERY params per
    // swagger.json's `ItemBean` -- it has no staging/stagingUuid property,
    // so this must NOT be sent in the body (see header comment).
    const query = `draft=${String(req.draft)}&file=${encodeURIComponent(req.stagingUuid)}`;
    const res = await this.request(`/api/item?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: { uuid: req.collectionUuid },
        metadata: req.metadata,
        attachments: req.attachments.map((a) => ({
          type: 'file',
          filename: a.filename,
          description: a.description,
          ...(a.uuid ? { uuid: a.uuid } : {}),
        })),
      }),
    });
    return this.parseCreateItemResponse(res);
  }

  /**
   * POST /item's only documented response is "successful operation" with no
   * schema (see header comment) -- the body shape is genuinely unspecified.
   * Tries a JSON body first, then falls back to openEQUELLA's common
   * `Location: /item/{uuid}/{version}` header on an empty/unparseable body.
   * If neither yields a uuid, this throws rather than silently treating an
   * ambiguous 2xx as a failure: the item may well already exist on the
   * server at that point, and a caller-level retry (Task 10's runner) would
   * create a duplicate rather than fix anything. Reusing `res.status` (a
   * 2xx here, since `request()` already rejected non-ok responses) keeps
   * `ApiError.retryable` false for this case without special-casing it.
   */
  private async parseCreateItemResponse(res: Response): Promise<CreateItemResult> {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          uuid?: string;
          version?: number;
          attachments?: { uuid: string }[];
        };
        if (parsed.uuid) {
          return {
            uuid: parsed.uuid,
            version: parsed.version ?? 1,
            attachmentUuids: (parsed.attachments ?? []).map((a) => a.uuid),
          };
        }
      } catch {
        // Not JSON -- fall through to the Location-header path below.
      }
    }

    const location = res.headers.get('location');
    const match = location ? /\/item\/([^/]+)\/(\d+)/.exec(location) : null;
    if (match) {
      const [, uuid, version] = match;
      // No attachment uuids are recoverable from a Location-only response.
      // upload.ts's uuid-echo check treats an empty array as "nothing to
      // compare against" and trusts the uuid we supplied -- see that
      // module's comment on `processEntry`.
      return { uuid: uuid!, version: Number(version), attachmentUuids: [] };
    }

    throw new ApiError(
      `createItem: server returned ${res.status} but no item uuid could be recovered ` +
        `from the response body or a Location header. The item may already have been ` +
        `created on the server -- check the collection manually before retrying this row.`,
      res.status,
      text,
    );
  }

  /**
   * Advisory only — a hit is a question for the operator, never a silent
   * skip.
   *
   * `showall=true` is required (CONFIRMED against swagger.json, see header
   * comment): /search's default excludes items that are not live, and
   * items created by this tool default to draft. Without it, every search
   * here would silently exclude the very rows most likely to be recent
   * duplicates -- the ones from this tool's own earlier, not-yet-published
   * runs -- and a re-run would report "no duplicates" and recreate them.
   *
   * LIMITATION (still unverified wire format, see header): this sends the
   * identifier as a quoted phrase (`"..."`) hoping the server treats it as an
   * exact-phrase match, but whether `/api/search`'s `q` parameter actually
   * honours phrase quoting or instead does free-text/OR-of-terms matching is
   * UNCONFIRMED -- swagger.json documents `q` only as "Query string", with
   * no matching semantics specified. If it's the latter, a search for
   * `"Arnett, Erin 072126.MP4"` could match unrelated items that merely
   * share a word (e.g. another "Erin" or another ".MP4" filename token),
   * producing a false positive. That is an acceptable failure mode ONLY
   * because the result is advisory and reviewed by a human, never used to
   * auto-skip a row; a false negative (missing a real duplicate) is a
   * bigger concern than a false positive here, and neither is fatal since a
   * human sees it either way.
   */
  async identifierExists(collectionUuid: string, identifier: string): Promise<boolean> {
    const url =
      `/api/search?collections=${encodeURIComponent(collectionUuid)}` +
      `&q=${encodeURIComponent(`"${identifier}"`)}&length=1&showall=true`;
    const res = await this.request(url);
    const body = (await res.json()) as { available: number };
    return body.available > 0;
  }
}
