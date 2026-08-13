import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { OeqClient, escapeWhereValue } from '../src/core/client.js';
import { parseCollections } from '../src/core/discovery.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { ApiError, ValidationError } from '../src/core/errors.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

/** The real body an UNAUTHENTICATED `GET /api/content/currentuser` returns -- 200, not 401. */
const guestUser = JSON.parse(readFileSync('tests/fixtures/api/currentuser-guest.json', 'utf8'));

let mock: MockServer;
let client: OeqClient;

beforeEach(async () => {
  mock = await startMockServer();
  client = new OeqClient(mock.url, new OAuthClientCredentials(mock.url, 'good-id', 'secret'));
});
afterEach(async () => {
  await mock.close();
});

describe('OeqClient', () => {
  it('creates a staging area', async () => {
    const uuid = await client.createStagingArea();
    expect(mock.state.stagingAreas.has(uuid)).toBe(true);
  });

  it('creates a draft item and returns its uuid', async () => {
    const result = await client.createItem({
      collectionUuid: 'c1',
      metadata: '<xml><MWDL><title>T</title></MWDL></xml>',
      stagingUuid: await client.createStagingArea(),
      attachments: [{ filename: 'a.mp4', description: 'a.mp4', uuid: 'att-fixed' }],
      draft: true,
    });
    expect(result.uuid).toMatch(/^item-/);
    expect(mock.state.items[0]!.draft).toBe(true);
  });

  it('creates a published (non-draft) item when draft is false', async () => {
    // Getting draft/published backwards would publish live items into a
    // collection with no moderation workflow -- the worst outcome this tool
    // can produce. Explicitly exercise draft: false, not just draft: true.
    const result = await client.createItem({
      collectionUuid: 'c1',
      metadata: '<xml/>',
      stagingUuid: await client.createStagingArea(),
      attachments: [],
      draft: false,
    });
    const created = mock.state.items.find((i) => i.uuid === result.uuid);
    expect(created?.draft).toBe(false);
  });

  it('refuses to create an item when draft is not an explicit boolean', async () => {
    // The mock/assumed server treats anything other than the exact string
    // 'true' as publish-live -- a missing, undefined, or malformed `draft`
    // value fails open toward publishing 37 student videos live into a
    // collection with no moderation workflow. A manifest read back from disk
    // (Task 10) is JSON, so TypeScript's `draft: boolean` cannot protect this
    // at compile time; it must be checked at runtime.
    const err = await client
      .createItem({
        collectionUuid: 'c1',
        metadata: '<xml/>',
        stagingUuid: await client.createStagingArea(),
        attachments: [],
        draft: undefined as unknown as boolean,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    // Nothing must have been sent to the server -- proving this is a
    // client-side refusal, not a request that reached /api/item at all.
    expect(mock.state.items.length).toBe(0);
  });

  it('transparently refreshes an expired token', async () => {
    await client.createStagingArea();
    mock.state.expireNext = 1;
    await expect(client.createStagingArea()).resolves.toMatch(/^staging-/);
    expect(mock.state.issuedTokens.length).toBeGreaterThan(1);
  });

  it('reports 5xx as retryable and 4xx as not', async () => {
    mock.state.failItemNext = 1;
    const err = await client
      .createItem({
        collectionUuid: 'c1',
        metadata: '<xml/>',
        stagingUuid: 'nope',
        attachments: [],
        draft: true,
      })
      .catch((e: unknown) => e);
    expect((err as { status: number; retryable: boolean }).status).toBe(503);
    expect((err as { retryable: boolean }).retryable).toBe(true);
  });

  it('detects an existing identifier', async () => {
    mock.state.existingIdentifiers = ['Aster, Juniper 010125.MP4'];
    expect(await client.identifierExists('c1', 'Aster, Juniper 010125.MP4')).toBe(true);
    expect(await client.identifierExists('c1', 'Nobody 000000.MP4')).toBe(false);
  });

  it('sends the staging uuid as a query parameter, not a body field (confirmed against swagger.json)', async () => {
    const stagingUuid = await client.createStagingArea();
    const result = await client.createItem({
      collectionUuid: 'c1',
      metadata: '<xml/>',
      stagingUuid,
      attachments: [],
      draft: true,
    });
    const created = mock.state.items.find((i) => i.uuid === result.uuid);
    // ItemBean has no staging/stagingUuid property -- a server following the
    // documented contract would silently ignore it in the body, creating an
    // item whose attachment references a staging area the request never
    // actually told the server about. This proves it travels as `?file=`.
    expect(created?.stagingFile).toBe(stagingUuid);
  });

  it('fails item creation when the referenced staging area does not exist', async () => {
    const err = await client
      .createItem({
        collectionUuid: 'c1',
        metadata: '<xml/>',
        stagingUuid: 'never-created',
        attachments: [],
        draft: true,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    // Confirms nothing was created despite the 4xx -- a regression to the
    // old body-field behaviour would have silently created the item anyway.
    expect(mock.state.items.length).toBe(0);
  });

  it('only surfaces a draft item to identifierExists via showall=true', async () => {
    mock.state.existingIdentifiers = ['Aster, Juniper 010125.MP4'];
    // Items are created as drafts by default, i.e. not live. Confirm
    // directly against the mock (bypassing the client) that /api/search
    // excludes the match without showall=true -- proving that
    // identifierExists's showall=true is what makes a draft duplicate
    // visible at all, not an accident of the mock always matching.
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    const token = await auth.getToken();
    const res = await fetch(
      `${mock.url}/api/search?collections=c1&q=${encodeURIComponent(
        '"Aster, Juniper 010125.MP4"',
      )}&length=1`,
      { headers: { 'X-Authorization': `access_token=${token}` } },
    );
    const withoutShowAll = (await res.json()) as { available: number };
    expect(withoutShowAll.available).toBe(0);
    expect(await client.identifierExists('c1', 'Aster, Juniper 010125.MP4')).toBe(true);
  });

  it('recovers uuid/version from a 201 with an empty body and a Location header', async () => {
    // POST /item's response has no documented schema in swagger.json.
    // openEQUELLA commonly returns this shape instead of a JSON body;
    // treating it as a parse failure would misreport a genuinely-created
    // item as failed and cause a retry to create a duplicate.
    mock.state.locationStyleNext = 1;
    const result = await client.createItem({
      collectionUuid: 'c1',
      metadata: '<xml/>',
      stagingUuid: await client.createStagingArea(),
      attachments: [],
      draft: true,
    });
    expect(result.uuid).toMatch(/^item-/);
    expect(result.version).toBe(1);
    expect(result.attachmentUuids).toEqual([]);
    // The item really was created server-side -- not just a client-side guess.
    expect(mock.state.items.some((i) => i.uuid === result.uuid)).toBe(true);
  });

  it('does not retry forever when the token is invalid twice in a row', async () => {
    mock.state.expireNext = 2;
    const err = await client.createStagingArea().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    // 401 must never be auto-retried by the runner: it's indistinguishable
    // from a genuinely bad credential once the client's own one-shot retry
    // has already failed.
    expect((err as ApiError).retryable).toBe(false);
  });

  it('refuses to silently retry a 401 when the request body is a one-shot stream', async () => {
    const stagingUuid = await client.createStagingArea();
    mock.state.expireNext = 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const err = await client
      .uploadToStaging(stagingUuid, 'a.bin', stream)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toMatch(/stream|body/i);
    expect((err as ApiError).message).toMatch(/retr/i);
    // No upload should have been recorded -- silently sending an empty
    // second request would be far worse than failing loudly.
    expect(mock.state.uploads.length).toBe(0);
  });

  it('produces a non-retryable ApiError for a 404', async () => {
    const err = await client
      .uploadToStaging('no-such-staging-area', 'a.bin', 'hello')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).retryable).toBe(false);
  });

  describe('searchByTitle', () => {
    it('finds an item by exact title and returns its attachment filenames', async () => {
      mock.state.existingItems = [
        { uuid: 'i1', version: 1, title: 'Senior Recital', attachmentNames: ['Smith_Jane.pdf'] },
      ];
      expect(await client.searchByTitle('c1', 'Senior Recital', 'MWDL/title')).toEqual([
        { uuid: 'i1', version: 1, name: '', attachmentNames: ['Smith_Jane.pdf'] },
      ]);
    });

    it('does not match a title that merely shares a word', async () => {
      mock.state.existingItems = [
        { uuid: 'i1', version: 1, title: 'Senior Recital', attachmentNames: [] },
      ];
      expect(await client.searchByTitle('c1', 'Recital', 'MWDL/title')).toEqual([]);
      expect(await client.searchByTitle('c1', 'Senior', 'MWDL/title')).toEqual([]);
    });

    it('matches a title containing an apostrophe', async () => {
      mock.state.existingItems = [
        { uuid: 'i1', version: 1, title: "Bach's Prelude", attachmentNames: ['b.pdf'] },
      ];
      expect(await client.searchByTitle('c1', "Bach's Prelude", 'MWDL/title')).toHaveLength(1);
    });

    it('returns nothing when the collection holds no such title', async () => {
      mock.state.existingItems = [];
      expect(await client.searchByTitle('c1', 'Senior Recital', 'MWDL/title')).toEqual([]);
    });

    /**
     * Items this tool creates are drafts. Without showall=true the search
     * excludes them, and the check would be blind to precisely the duplicates
     * it exists to catch -- this tool's own recent runs. That mistake has
     * already been made once in this codebase.
     */
    it('asks for non-live items, or it would never see this tool own drafts', async () => {
      mock.state.existingItems = [{ uuid: 'i1', version: 1, title: 'A Draft', attachmentNames: [] }];
      expect(await client.searchByTitle('c1', 'A Draft', 'MWDL/title')).toHaveLength(1);
    });

    it('asks for attachments, or the filename tier has nothing to compare', async () => {
      mock.state.existingItems = [
        { uuid: 'i1', version: 1, title: 'T', attachmentNames: ['only-if-info-requested.pdf'] },
      ];
      expect((await client.searchByTitle('c1', 'T', 'MWDL/title'))[0]?.attachmentNames).toEqual([
        'only-if-info-requested.pdf',
      ]);
    });

    it('copes with an item that has no attachments at all', async () => {
      mock.state.existingItems = [{ uuid: 'i1', version: 1, title: 'T', attachmentNames: [] }];
      expect((await client.searchByTitle('c1', 'T', 'MWDL/title'))[0]?.attachmentNames).toEqual([]);
    });

    /**
     * `MWDL/title` is BYU-Idaho's schema, not a universal one. A hardcoded
     * clause matches nothing at any other institution, so every row comes back
     * clean from a check that never looked -- the same shape of silent failure
     * this whole feature exists to prevent.
     */
    it('builds the where clause from the supplied path', async () => {
      mock.state.titlePath = 'local/dc/title';
      await client.searchByTitle('c1', 'A Thesis', 'local/dc/title');
      const asked = decodeURIComponent(mock.state.searchUrls[0] ?? '');
      expect(asked).toContain("/xml/local/dc/title = 'A Thesis'");
      expect(asked).not.toContain('MWDL');
    });

    /**
     * showall=true is mandatory: /search excludes non-live items by default,
     * and everything this tool creates is a draft. Omitting it made the check
     * blind to this tool's own uploads once already. Asserted on the URL as
     * well as on behaviour above, so a change to the clause cannot quietly
     * drop it.
     */
    it('still sends showall=true, which drafts depend on', async () => {
      mock.state.titlePath = 'local/dc/title';
      await client.searchByTitle('c1', 'A Thesis', 'local/dc/title');
      expect(mock.state.searchUrls[0]).toContain('showall=true');
    });

    it('finds an item through a path other than MWDL/title', async () => {
      mock.state.titlePath = 'local/dc/title';
      mock.state.existingItems = [
        { uuid: 'i1', version: 1, title: 'A Thesis', attachmentNames: ['thesis.pdf'] },
      ];
      expect(await client.searchByTitle('c1', 'A Thesis', 'local/dc/title')).toEqual([
        { uuid: 'i1', version: 1, name: '', attachmentNames: ['thesis.pdf'] },
      ]);
    });
  });
});

describe('OeqClient — currentUser', () => {
  it('returns the authenticated user', async () => {
    mock.state.currentUser = { id: 'u-1', username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
    const user = await client.currentUser();
    expect(user).toEqual({
      id: 'u-1',
      username: 'jdoe',
      firstName: 'Jane',
      lastName: 'Doe',
      guest: false,
    });
  });

  /**
   * THE FIELD THIS USED TO DISCARD. openEQUELLA does not answer an
   * unauthenticated request with 401 -- it answers 200 as the guest identity
   * (recorded verbatim in the fixture below). Reading only
   * username/firstName/lastName made "not signed in at all" and "signed in"
   * the same success, which is how `oeq-upload check` came to report
   * "Identity ok -- logged in as guest ( )" as a PASS.
   */
  it('carries `guest` through from the real unauthenticated response', async () => {
    mock.state.currentUser = guestUser;
    const user = await client.currentUser();
    expect(user.guest).toBe(true);
    expect(user.username).toBe('guest');
    expect(user.id).toBe('guest');
  });

  // A response that simply does not mention it is not a guest session. Only an
  // explicit `true` means guest; anything else is read as a real account, and
  // the Identity check (preflight.ts) is what refuses to call that proof.
  it('treats an absent `guest` field as not guest', async () => {
    mock.state.currentUser = { username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
    expect((await client.currentUser()).guest).toBe(false);
  });
});

describe('OeqClient — getCollection', () => {
  it('returns the collection when it exists on this host', async () => {
    mock.state.collections.push({ uuid: 'c1', name: 'Faculty Content', privileges: [] });
    const collection = await client.getCollection('c1');
    // schemaUuid is '' because this collection declares no schema; the
    // pre-flight tells that apart from a schema it could not read.
    expect(collection).toEqual({ uuid: 'c1', name: 'Faculty Content', schemaUuid: '' });
  });

  it("carries the collection's declared schema uuid, so nothing has to configure it twice", async () => {
    mock.state.collections.push({
      uuid: 'c2',
      name: 'Other Collection',
      privileges: [],
      schemaUuid: 's1',
    });
    expect((await client.getCollection('c2')).schemaUuid).toBe('s1');
  });

  it('reads a schema, parsing its declared name path and valid xpaths', async () => {
    mock.state.schemas.push({
      uuid: 's1',
      namePath: '/MWDL/title',
      paths: ['MWDL/title', 'Local/attachments/attachment'],
    });
    const schema = await client.getSchema('s1');
    expect(schema.titleHeader).toBe('MWDL/title');
    expect(schema.paths.has('Local/attachments/attachment')).toBe(true);
    expect(schema.paths.has('Nothing/like/this')).toBe(false);
  });

  it('throws a non-retryable 404 ApiError when the collection does not exist on this host', async () => {
    const err = await client.getCollection('does-not-exist').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).retryable).toBe(false);
  });

  it('falls back to the uuid when name is missing or an unrecognised shape', async () => {
    mock.state.collections.push({ uuid: 'c2', name: '', privileges: [] });
    const collection = await client.getCollection('c2');
    expect(collection.name).toBe('c2');
  });
});

describe('OeqClient — listCollections', () => {
  it('filters by privilege', async () => {
    mock.state.collections.push(
      { uuid: 'c1', name: 'Contributable', privileges: ['CREATE_ITEM'], schemaUuid: 's1' },
      { uuid: 'c2', name: 'View only', privileges: ['VIEW_ITEM'], schemaUuid: 's1' },
    );
    const { collections } = await client.listCollections({ privilege: 'CREATE_ITEM' });
    expect(collections).toEqual([{ uuid: 'c1', name: 'Contributable', schemaUuid: 's1' }]);
  });

  /**
   * `full=true` OR NO SCHEMA. Confirmed against the live instance: without it,
   * every entry comes back as `uuid, name, nameStrings, readonly, links` and
   * no `schema` field at all -- so `schemaUuid` was '' for every collection,
   * and everything that hangs off the schema (the declared title path, the
   * attachment-field check, the offline schema cache) degraded silently.
   *
   * Asserted on the REQUEST, not on the answer, because the answer only shows
   * the consequence -- and a mock that hands the schema over regardless would
   * hide it entirely.
   */
  it('asks for the full collection record, or no entry carries its schema', async () => {
    await client.listCollections({ privilege: 'CREATE_ITEM' });
    expect(mock.state.collectionUrls).toHaveLength(1);
    expect(mock.state.collectionUrls[0]).toContain('full=true');
  });

  /**
   * The two recorded shapes, side by side: `collections-test-instance.json` is
   * a real authenticated list fetched WITHOUT `full=true` (29 entries, not one
   * `schema` between them), and `collections.json` is the same endpoint WITH
   * it (`schema: { uuid }` on every entry). Parsing both here pins the
   * consequence of the parameter to real data rather than to the mock.
   */
  it('reads a schema uuid from a full record, and none from a record without one', () => {
    const withoutFull = JSON.parse(
      readFileSync('tests/fixtures/api/collections-test-instance.json', 'utf8'),
    );
    const withFull = JSON.parse(readFileSync('tests/fixtures/api/collections.json', 'utf8'));
    expect(parseCollections(withoutFull).collections.every((c) => c.schemaUuid === '')).toBe(true);
    expect(parseCollections(withFull).collections.every((c) => c.schemaUuid !== '')).toBe(true);
  });

  /**
   * The desktop's collection dropdown read "showing 0 of 0 -- No collections
   * match" against a session that was not signed in at all. The count the
   * server sent alongside those zero rows is the only thing that tells the two
   * apart, so the client must hand it on rather than flatten the answer to an
   * array.
   */
  it('reports a withheld list as withheld rather than as an empty one', async () => {
    mock.state.collections.push({ uuid: 'c1', name: 'A', privileges: ['CREATE_ITEM'] });
    mock.state.withholdCollections = true;
    const list = await client.listCollections({ privilege: 'CREATE_ITEM' });
    expect(list.collections).toEqual([]);
    expect(list.available).toBe(1);
    expect(list.withheld).toBe(true);
  });

  /**
   * The field the inline parse this method used to carry dropped on the
   * floor. Each list entry declares its schema, so choosing a collection
   * determines its schema in ONE hop -- which is what lets Setup offer or
   * check an attachment-uuid path against the schema that collection really
   * uses, instead of asking a non-technical operator to know a uuid.
   */
  it('carries each collection\'s schema uuid, from parseCollections', async () => {
    mock.state.collections.push(
      { uuid: 'c1', name: 'Faculty Content', privileges: ['CREATE_ITEM'], schemaUuid: 'schema-abc' },
    );
    const [only] = (await client.listCollections({ privilege: 'CREATE_ITEM' })).collections;
    expect(only?.schemaUuid).toBe('schema-abc');
  });

  // A collection whose response declares no schema is '' -- distinguishable
  // from a schema that could not be read, and never undefined-by-accident.
  it('reports an undeclared schema as empty rather than missing', async () => {
    mock.state.collections.push({ uuid: 'c1', name: 'No schema', privileges: ['CREATE_ITEM'] });
    const [only] = (await client.listCollections({ privilege: 'CREATE_ITEM' })).collections;
    expect(only?.schemaUuid).toBe('');
  });

  it('returns everything when no privilege filter is given', async () => {
    mock.state.collections.push(
      { uuid: 'c1', name: 'A', privileges: ['CREATE_ITEM'] },
      { uuid: 'c2', name: 'B', privileges: [] },
    );
    const { collections } = await client.listCollections();
    expect(collections.map((c) => c.uuid).sort()).toEqual(['c1', 'c2']);
  });

  /**
   * Nothing matched the privilege, and the server said so: `available: 0`.
   * That is a real account state, not a withheld list, and must keep reading
   * as one.
   */
  it('returns an empty list when no collection matches the privilege', async () => {
    mock.state.collections.push({ uuid: 'c1', name: 'A', privileges: [] });
    const list = await client.listCollections({ privilege: 'CREATE_ITEM' });
    expect(list.collections).toEqual([]);
    expect(list.withheld).toBe(false);
  });
});

describe('escapeWhereValue', () => {
  // A music library. "Bach's Prelude" is not a hypothetical title.
  it('doubles a single quote so it cannot end the literal early', () => {
    expect(escapeWhereValue("Bach's Prelude")).toBe("Bach''s Prelude");
  });

  it('doubles every quote, not just the first', () => {
    expect(escapeWhereValue("A's B's")).toBe("A''s B''s");
  });

  it('leaves an ordinary title untouched', () => {
    expect(escapeWhereValue('Senior Recital')).toBe('Senior Recital');
  });

  it('leaves a backslash alone', () => {
    expect(escapeWhereValue('a\\b')).toBe('a\\b');
  });

  it('leaves a newline alone, for the URL encoder to deal with', () => {
    expect(escapeWhereValue('a\nb')).toBe('a\nb');
  });

  it('handles an empty string', () => {
    expect(escapeWhereValue('')).toBe('');
  });
});

/**
 * EVERY API call funnels through `OeqClient.request()`, so this one line is
 * the whole tool's exposure to the prefix defect: `new URL(path, base)` with
 * an absolute `path` discards the base's path, and openEQUELLA is very
 * commonly deployed under one.
 *
 * These assert on the URL actually fetched, including the query string --
 * `path` carries it already (`/api/collection?privilege=...&full=true`), so a
 * naive fix that rebuilt the URL could drop it and break search and discovery
 * at a prefixed site only.
 */
describe('OeqClient — an instance hosted under a path prefix', () => {
  const PREFIXED = 'https://library.example.edu/oeq';

  /** Enough of an AuthProvider to make a request; the header is irrelevant here. */
  const stubAuth = {
    getToken: async () => 'tok',
    authHeader: async () => ({ 'X-Authorization': 'access_token=tok' }),
    invalidate: () => {},
  };

  const captureFetch = (body: unknown): string[] => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return seen;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests under the prefix rather than at the host root', async () => {
    const seen = captureFetch({ username: 'jsmith', firstName: 'J', lastName: 'S', guest: false });
    await new OeqClient(PREFIXED, stubAuth).currentUser();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith('https://library.example.edu/oeq/')).toBe(true);
    expect(new URL(seen[0]!).pathname).toBe('/oeq/api/content/currentuser');
  });

  it('keeps the query string intact under a prefix', async () => {
    const seen = captureFetch({ start: 0, length: 0, available: 0, results: [], resumptionToken: '' });
    await new OeqClient(PREFIXED, stubAuth).listCollections({ privilege: 'CREATE_ITEM' });
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe('/oeq/api/collection');
    expect(url.searchParams.get('privilege')).toBe('CREATE_ITEM');
    expect(url.searchParams.get('full')).toBe('true');
    expect(url.searchParams.get('length')).toBe('100');
  });

  it('still hits the host root when the base has no prefix', async () => {
    const seen = captureFetch({ start: 0, length: 0, available: 0, results: [], resumptionToken: '' });
    await new OeqClient('https://oeq.example.edu', stubAuth).listCollections({});
    expect(new URL(seen[0]!).pathname).toBe('/api/collection');
  });
});
