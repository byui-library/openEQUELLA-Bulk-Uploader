import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OeqClient, escapeWhereValue } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { ApiError, ValidationError } from '../src/core/errors.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

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
      expect(await client.searchByTitle('c1', 'Senior Recital')).toEqual([
        { uuid: 'i1', version: 1, name: '', attachmentNames: ['Smith_Jane.pdf'] },
      ]);
    });

    it('does not match a title that merely shares a word', async () => {
      mock.state.existingItems = [
        { uuid: 'i1', version: 1, title: 'Senior Recital', attachmentNames: [] },
      ];
      expect(await client.searchByTitle('c1', 'Recital')).toEqual([]);
      expect(await client.searchByTitle('c1', 'Senior')).toEqual([]);
    });

    it('matches a title containing an apostrophe', async () => {
      mock.state.existingItems = [
        { uuid: 'i1', version: 1, title: "Bach's Prelude", attachmentNames: ['b.pdf'] },
      ];
      expect(await client.searchByTitle('c1', "Bach's Prelude")).toHaveLength(1);
    });

    it('returns nothing when the collection holds no such title', async () => {
      mock.state.existingItems = [];
      expect(await client.searchByTitle('c1', 'Senior Recital')).toEqual([]);
    });

    /**
     * Items this tool creates are drafts. Without showall=true the search
     * excludes them, and the check would be blind to precisely the duplicates
     * it exists to catch -- this tool's own recent runs. That mistake has
     * already been made once in this codebase.
     */
    it('asks for non-live items, or it would never see this tool own drafts', async () => {
      mock.state.existingItems = [{ uuid: 'i1', version: 1, title: 'A Draft', attachmentNames: [] }];
      expect(await client.searchByTitle('c1', 'A Draft')).toHaveLength(1);
    });

    it('asks for attachments, or the filename tier has nothing to compare', async () => {
      mock.state.existingItems = [
        { uuid: 'i1', version: 1, title: 'T', attachmentNames: ['only-if-info-requested.pdf'] },
      ];
      expect((await client.searchByTitle('c1', 'T'))[0]?.attachmentNames).toEqual([
        'only-if-info-requested.pdf',
      ]);
    });

    it('copes with an item that has no attachments at all', async () => {
      mock.state.existingItems = [{ uuid: 'i1', version: 1, title: 'T', attachmentNames: [] }];
      expect((await client.searchByTitle('c1', 'T'))[0]?.attachmentNames).toEqual([]);
    });
  });
});

describe('OeqClient — currentUser', () => {
  it('returns the authenticated user', async () => {
    mock.state.currentUser = { username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
    const user = await client.currentUser();
    expect(user).toEqual({ username: 'jdoe', firstName: 'Jane', lastName: 'Doe' });
  });
});

describe('OeqClient — getCollection', () => {
  it('returns the collection when it exists on this host', async () => {
    mock.state.collections.push({ uuid: 'c1', name: 'Faculty Content', privileges: [] });
    const collection = await client.getCollection('c1');
    expect(collection).toEqual({ uuid: 'c1', name: 'Faculty Content' });
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
      { uuid: 'c1', name: 'Contributable', privileges: ['CREATE_ITEM'] },
      { uuid: 'c2', name: 'View only', privileges: ['VIEW_ITEM'] },
    );
    const results = await client.listCollections({ privilege: 'CREATE_ITEM' });
    expect(results).toEqual([{ uuid: 'c1', name: 'Contributable' }]);
  });

  it('returns everything when no privilege filter is given', async () => {
    mock.state.collections.push(
      { uuid: 'c1', name: 'A', privileges: ['CREATE_ITEM'] },
      { uuid: 'c2', name: 'B', privileges: [] },
    );
    const results = await client.listCollections();
    expect(results.map((c) => c.uuid).sort()).toEqual(['c1', 'c2']);
  });

  it('returns an empty list when no collection matches the privilege', async () => {
    mock.state.collections.push({ uuid: 'c1', name: 'A', privileges: [] });
    const results = await client.listCollections({ privilege: 'CREATE_ITEM' });
    expect(results).toEqual([]);
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
