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
import { instanceEndpoint } from './instanceUrl.js';
import {
  displayName,
  parseCollections,
  parseSchema,
  type CollectionList,
  type SchemaInfo,
} from './discovery.js';

export type { CollectionList } from './discovery.js';

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
  /** The account's own id. `'guest'` on an unauthenticated session. */
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  /**
   * THE FIELD THAT SAYS WHETHER ANYONE IS SIGNED IN.
   *
   * openEQUELLA never answers an unauthenticated request with 401. Measured
   * against content-test.byui.edu with no credentials at all, this endpoint
   * returned 200 and `{"id":"guest","username":"guest","guest":true,...}`
   * (recorded verbatim in tests/fixtures/api/currentuser-guest.json). This
   * client used to read only username/firstName/lastName and discard `guest`,
   * which made "not signed in at all" and "signed in" the same success --
   * and `oeq-upload check` reported "Identity ok -- logged in as guest ( )"
   * as a PASS.
   *
   * A SUCCESSFUL CALL IS THEREFORE NOT PROOF OF SIGN-IN. Every caller has to
   * read this. `true` only when the response says so explicitly; a response
   * that does not mention it is read as a real account.
   */
  guest: boolean;
}

export interface CollectionSummary {
  uuid: string;
  name: string;
  /**
   * The schema this collection contributes against, from the response's
   * `schema: { uuid }`. CONFIRMED present on `GET /collection/{uuid}` --
   * tests/fixtures/api/collection-one.json, recorded live -- and on every
   * entry of `GET /collection` (tests/fixtures/api/collections.json, same
   * recording). `''` when the response declares none, so a caller can tell
   * "no schema named" from a schema that could not be read.
   *
   * BOTH `getCollection` and `listCollections` populate it. The list used not
   * to: its inline parse read `uuid` and `name` only, which is why picking a
   * collection could not resolve its schema without a second request.
   */
  schemaUuid?: string;
}

/** One item already in the collection, as the duplicate check needs to see it. */
export interface SearchHit {
  uuid: string;
  version: number;
  /**
   * The item's title. CONFIRMED empty in practice: the live search returns no
   * `name` field, even with info=basic. Kept because the verdict rules use it
   * as a belt-and-braces check when it IS present.
   */
  name: string;
  /** Filenames of this item's attachments. Empty if it has none. */
  attachmentNames: string[];
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
 * UNVERIFIED: a doubled single quote is ASSUMED to be the escape this
 * instance accepts. `scripts/probe-where.mts` settles it against the test
 * instance; until that has run, this is a guess with the same standing as the
 * two wire-format assumptions this project has already been wrong about. A
 * title containing an apostrophe would otherwise end the literal early and
 * either error or, far worse, silently change what is being matched.
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
    //
    // instanceEndpoint(), not `new URL(path, base)`: the latter drops any
    // hosting prefix on the base, and this line is EVERY API call the tool
    // makes. `path` arrives with its query string already attached; the
    // helper preserves it. See instanceUrl.ts.
    const url = instanceEndpoint(this.baseUrl, path);
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
   * Items in the collection whose title is EXACTLY `title`.
   *
   * CONFIRMED against production on 2026-08-07: the `where` clause works with
   * this syntax and genuinely filters -- a title known to be absent returned
   * `available: 0`, while one known to be present returned exactly one hit.
   *
   * Uses `where` rather than free-text `q`. `identifierExists` uses `q` and its
   * own comment concedes the phrase-quoting behaviour is unconfirmed: a `q`
   * search for "Senior Recital" may match anything containing "senior" or
   * "recital". False alarms are not harmless -- they train the operator to
   * click past the warning, which is worse than no check. `where` also makes
   * this viable against a collection of 100,000+ items, where reading
   * everything is not an option.
   *
   * `showall=true` is mandatory -- see identifierExists' note; every item this
   * tool creates is a draft, and the default excludes them.
   *
   * `info=basic,attachment` brings each hit's attachments back in the same
   * response, so comparing filenames costs no extra requests. The `basic` part
   * is asked for because `info` REPLACES the default rather than adding to it;
   * it does not in fact yield a `name`, but asking costs nothing and stops the
   * omission looking deliberate.
   *
   * `titleHeader` is REQUIRED and has no default. It is the schema's declared
   * item name path in spreadsheet-header form (`MWDL/title` at BYU-Idaho,
   * something else everywhere else). Defaulting it would be worse than a
   * compile error: a clause naming a path the schema does not declare matches
   * nothing, so the caller is told the batch is clean by a query that could
   * never have found anything. Callers read it from the schema -- see
   * discovery.ts#parseSchema and schema.ts#extractItemNamePath.
   */
  async searchByTitle(
    collectionUuid: string,
    title: string,
    titleHeader: string,
    limit = 50,
  ): Promise<SearchHit[]> {
    const clause = `/xml/${titleHeader} = '${escapeWhereValue(title)}'`;
    const url =
      `/api/search?collections=${encodeURIComponent(collectionUuid)}` +
      `&where=${encodeURIComponent(clause)}` +
      `&info=${encodeURIComponent('basic,attachment')}&showall=true&length=${limit}`;
    const res = await this.request(url);
    const body = (await res.json()) as {
      results?: {
        uuid?: string;
        version?: number;
        name?: string;
        attachments?: { filename?: string; description?: string }[];
      }[];
    };
    return (body.results ?? []).map((r) => ({
      uuid: r.uuid ?? '',
      version: r.version ?? 1,
      name: r.name ?? '',
      // `filename` is where production puts it; `description` carried the same
      // value in the observed response, so it is a harmless fallback rather
      // than a guess between two candidates.
      attachmentNames: (r.attachments ?? [])
        .map((a) => a.filename ?? a.description ?? '')
        .filter((n) => n !== ''),
    }));
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
    const body = (await res.json()) as {
      id?: unknown;
      username?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      guest?: unknown;
    };
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
      id: str(body.id),
      username: str(body.username),
      firstName: str(body.firstName),
      lastName: str(body.lastName),
      // `=== true`, not truthiness: only the server saying so makes this a
      // guest session. See CurrentUser.guest -- this is the field that tells a
      // 200 from a sign-in.
      guest: body.guest === true,
    };
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
    const body = (await res.json()) as { uuid: string; name?: unknown; schema?: { uuid?: unknown } };
    return {
      uuid: body.uuid,
      name: displayName(body.name, body.uuid),
      schemaUuid: typeof body.schema?.uuid === 'string' ? body.schema.uuid : '',
    };
  }

  /**
   * `GET /schema/{uuid}` -> the schema's declared name path and its valid
   * xpaths, parsed by discovery.ts#parseSchema (which is where the response
   * shape is documented and pinned to a recorded fixture).
   *
   * Choosing a collection determines its schema -- `getCollection` above
   * returns the uuid -- so nothing has to configure this separately. Used by
   * the pre-flight to check a configured attachment-uuid path against the
   * paths the schema actually declares.
   */
  async getSchema(uuid: string): Promise<SchemaInfo> {
    const res = await this.request(`/api/schema/${encodeURIComponent(uuid)}`);
    return parseSchema(await res.json());
  }

  /**
   * CONFIRMED against swagger.json's `GET /collection` (`privilege` is a
   * documented, repeatable filter query param; `PagingBeanCollectionBean` is
   * the response shape). Used by `check`/`oeq_check` with
   * `privilege: 'CREATE_ITEM'` to confirm the current user can actually
   * contribute to the target collection -- and, if not, to list the ones
   * they can. Also by the desktop's Setup screen, which offers the operator
   * the collections they can actually contribute to instead of asking them
   * for a uuid.
   *
   * The body is read by `discovery.ts#parseCollections`, NOT by an inline
   * parse here. There used to be one, and it dropped each entry's
   * `schema.uuid` -- the single fact that lets a chosen collection resolve to
   * its schema without a second request, which is exactly what Setup needs to
   * offer or check an attachment-uuid path. See parseCollections.
   *
   * `full=true` IS NOT OPTIONAL. CONFIRMED against the live instance: without
   * it every entry comes back as `uuid, name, nameStrings, readonly, links`
   * and carries no `schema` field whatsoever, so `schemaUuid` was '' for every
   * collection and the entire discovery design -- choose a collection, get its
   * schema in one hop -- silently produced nothing. The declared title path,
   * the attachment-field check and the offline schema cache all degraded
   * without a single error. It was missing here for exactly as long as
   * nothing asserted on the request.
   *
   * Returns the whole `CollectionList`, not just the rows: an empty list from
   * an unauthenticated session is not an empty list, and only the `available`
   * count that comes back beside the rows can tell those apart. Callers decide
   * what to say about it -- see `CollectionList.withheld`.
   */
  async listCollections(
    opts: { privilege?: string; length?: number } = {},
  ): Promise<CollectionList> {
    const params = new URLSearchParams();
    if (opts.privilege) params.set('privilege', opts.privilege);
    params.set('length', String(opts.length ?? 100));
    // See above: without this, no entry carries a schema.
    params.set('full', 'true');
    const res = await this.request(`/api/collection?${params.toString()}`);
    return parseCollections(await res.json());
  }
}
