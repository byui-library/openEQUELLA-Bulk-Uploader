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
 *   - The staging-area endpoints this client and upload.ts use are an exact
 *     match: `POST /staging` ("Create a file area"), `GET /staging/{uuid}`
 *     ("Get a file area listing") and `DELETE /staging/{uuid}` ("Delete a
 *     staging area"), and `PUT /staging/{uuid}/{filepath}` ("Put a file",
 *     taking a raw `body` plus `content-length`/`content-type` headers, and
 *     — unused here — `partNumber`/`uploadId` for multipart uploads). The
 *     `/file/{uuid}/...` paths elsewhere in the spec are a *different* API,
 *     for files already attached to an existing item, not a staging
 *     replacement — do not conflate the two.
 *   - POST /item takes `file` (the staging area id) and `draft` as QUERY
 *     PARAMS, not body fields. `ItemBean` (the documented body schema) has
 *     no staging/stagingUuid property at all (it does have `collaborators`,
 *     for what it's worth) — a server that followed this spec would have
 *     silently ignored a body-embedded `stagingUuid`, creating an item
 *     whose attachment points at a staging area the request never actually
 *     told the server about. Fixed here; see createItem() below.
 *   - `draft`'s documented default is `false` — omitting it means
 *     PUBLISHED. This confirms the runtime guard in createItem() (added
 *     defensively before swagger.json was available) was the right call,
 *     not overcaution.
 *   - GET /search has a `showall` query param (default `false`) described
 *     as "If true then includes items that are not live", and a separate
 *     `status` param whose enum includes `draft`. Items here are created as
 *     drafts by default, i.e. not live — without `showall=true`,
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
 * STILL UNVERIFIED (swagger.json does not settle this):
 *   - `AttachmentBean`'s documented properties are `uuid, description,
 *     viewer, preview, erroredIndexing, restricted, externalId` — no
 *     `filename` or `type`. The spec does not model openEQUELLA's
 *     polymorphic attachment subtypes (file/url/etc.), so this client's
 *     `{ type: "file", filename, description, uuid? }` payload shape
 *     remains a guess. This is now the ONLY wire-format assumption left for
 *     a live smoke test to settle.
 *   - Two smaller items, noted for completeness rather than risk: whether
 *     `q` on /search performs an exact-phrase or free-text match (see the
 *     caveat on identifierExists() below — swagger.json documents `q` only
 *     as "Query string", with no matching semantics specified); and POST
 *     /oauth/access_token, which sits outside `/api`'s basePath and so is
 *     simply not covered by this document at all (see auth.ts).
 *
 * `tests/helpers/mockServer.ts` encodes this exact same contract. When the
 * next discrepancy turns up, THIS FILE and mockServer.ts are the only two
 * files that should need to change to reconcile it — every other module
 * (upload orchestration, the runner, the CLI) depends only on this client's
 * TypeScript interface, never on the wire format directly.
 *
 * ADDED for login/check (src/cli/index.ts, src/mcp/index.ts, both read-only):
 *   - CONFIRMED: `GET /content/currentuser` -> `CurrentUserDetails`
 *     (`username`/`firstName`/`lastName` used here).
 *   - CONFIRMED: `GET /collection/{uuid}` -> `CollectionBean`; `GET
 *     /collection?privilege=...&length=...` -> `PagingBeanCollectionBean`.
 *   - UNVERIFIED: `CollectionBean.name`'s `I18NString` type has no documented
 *     shape at all — see `extractDisplayName()` below, the same kind of gap
 *     as `AttachmentBean`.
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

/** Who the current OAuth token authenticates as -- see `CurrentUserDetails` in swagger.json. */
export interface CurrentUser {
  username: string;
  firstName: string;
  lastName: string;
}

export interface CollectionSummary {
  uuid: string;
  name: string;
}

/**
 * `CollectionBean.name` (swagger.json) is typed only as `I18NString`, which
 * is itself documented as a bare `{ type: "object" }` -- no shape at all, the
 * same kind of gap `AttachmentBean` has for `filename`/`type` (see this
 * file's header comment). In practice openEQUELLA's REST responses serialise
 * it as a plain string already resolved to the session's locale; this
 * defensively also accepts an `I18NStrings`-shaped object (`{ strings: {
 * [locale]: string } }`) in case a deployment does something else, and falls
 * back to the uuid rather than letting a missing display label crash `check`
 * / `oeq_check` over what is, worst case, cosmetic.
 */
function extractDisplayName(name: unknown, fallback: string): string {
  if (typeof name === 'string' && name) return name;
  if (name && typeof name === 'object') {
    const strings = (name as { strings?: Record<string, string> }).strings;
    if (strings) {
      const first = Object.values(strings).find((v) => typeof v === 'string' && v);
      if (first) return first;
    }
  }
  return fallback;
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

/**
 * Escape a value for interpolation into a search `where` clause.
 *
 * Doubling the single quote is the escape this instance accepts. A title
 * containing an apostrophe would otherwise end the literal early and either
 * error or, far worse, silently change what is being matched.
 *
 * Nothing else is escaped: everything is passed through `encodeURIComponent`
 * on the way into the URL, which handles newlines, backslashes and the rest.
 */
export function escapeWhereValue(value: string): string {
  return value.replace(/'/g, "''");
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

  /**
   * CONFIRMED against content-test.byui.edu: this returns `201` with an
   * EMPTY body (content-length 0, no content-type) and the uuid available
   * only in the `Location` header:
   *
   *   Location: https://content-test.byui.edu/api/staging/<uuid>
   *
   * A bare `res.json()` therefore throws "Unexpected end of JSON input" on
   * every single row -- which is exactly what the first live run did. Parse
   * the body when there is one (some deployments may send it), and fall back
   * to `Location` otherwise.
   */
  async createStagingArea(): Promise<string> {
    const res = await this.request('/api/staging', { method: 'POST' });

    const text = await res.text();
    if (text.trim() !== '') {
      try {
        const parsed = JSON.parse(text) as { uuid?: string };
        if (parsed.uuid) return parsed.uuid;
      } catch {
        // Not JSON -- fall through to the Location header.
      }
    }

    const location = res.headers.get('location');
    const uuid = location ? location.split('/').filter(Boolean).pop() : undefined;
    if (uuid) return uuid;

    throw new ApiError(
      `POST /api/staging succeeded (${res.status}) but no staging area uuid could be ` +
        `recovered from the response body or a Location header.`,
      res.status,
      text,
    );
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

  /**
   * Who the current token authenticates as -- CONFIRMED against
   * swagger.json's `CurrentUserDetails`. This is the whole point of the
   * authorization-code flow (authCode.ts): items get created under whoever
   * this says, not a fixed service account, so `login`/`check` (cli/index.ts,
   * mcp/index.ts) call this to show the operator who they're about to
   * contribute as before anything is uploaded.
   */
  async currentUser(): Promise<CurrentUser> {
    const res = await this.request('/api/content/currentuser');
    const body = (await res.json()) as { username: string; firstName: string; lastName: string };
    return { username: body.username, firstName: body.firstName, lastName: body.lastName };
  }

  /**
   * CONFIRMED against swagger.json's `GET /collection/{uuid}`. Throws the
   * same `ApiError` `request()` always throws on a non-2xx -- in particular
   * a 404 if `uuid` doesn't exist *on this host*, which is exactly the
   * "wrong instance" check `check`/`oeq_check` need: the collection UUID is
   * identical between test and production, so this is the only network call
   * that can catch OEQ_BASE_URL pointing at the wrong one.
   */
  async getCollection(uuid: string): Promise<CollectionSummary> {
    const res = await this.request(`/api/collection/${encodeURIComponent(uuid)}`);
    const body = (await res.json()) as { uuid: string; name?: unknown };
    return { uuid: body.uuid, name: extractDisplayName(body.name, body.uuid) };
  }

  /**
   * CONFIRMED against swagger.json's `GET /collection` (`privilege` is a
   * documented, repeatable filter query param; `PagingBeanCollectionBean` is
   * the response shape). Used by `check`/`oeq_check` with
   * `privilege: 'CREATE_ITEM'` to confirm the current user can actually
   * contribute to the target collection -- and, if not, to list the ones
   * they can.
   */
  async listCollections(opts: { privilege?: string; length?: number } = {}): Promise<CollectionSummary[]> {
    const params = new URLSearchParams();
    if (opts.privilege) params.set('privilege', opts.privilege);
    params.set('length', String(opts.length ?? 100));
    const res = await this.request(`/api/collection?${params.toString()}`);
    const body = (await res.json()) as { results: { uuid: string; name?: unknown }[] };
    return body.results.map((r) => ({ uuid: r.uuid, name: extractDisplayName(r.name, r.uuid) }));
  }
}
