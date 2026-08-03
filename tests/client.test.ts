import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { ApiError } from '../src/core/errors.js';
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
});
