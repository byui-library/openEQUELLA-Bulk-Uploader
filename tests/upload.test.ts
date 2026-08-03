import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadFile } from '../src/core/upload.js';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { ApiError, ValidationError } from '../src/core/errors.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

let mock: MockServer;
let client: OeqClient;
let dir: string;

beforeEach(async () => {
  mock = await startMockServer();
  client = new OeqClient(mock.url, new OAuthClientCredentials(mock.url, 'good-id', 'secret'));
  dir = await mkdtemp(join(tmpdir(), 'oeq-up-'));
});
afterEach(async () => {
  await mock.close();
});

describe('uploadFile', () => {
  it('streams the file into a staging area', async () => {
    const p = join(dir, 'clip.mp4');
    await writeFile(p, Buffer.alloc(4096, 7));
    const staging = await uploadFile(client, p, 'clip.mp4');
    expect(mock.state.uploads).toEqual([{ staging, filename: 'clip.mp4', bytes: 4096 }]);
  });

  it('preserves commas and spaces in the filename', async () => {
    const name = 'Aster, Juniper 010125.MP4';
    const p = join(dir, name);
    await writeFile(p, Buffer.alloc(16));
    await uploadFile(client, p, name);
    expect(mock.state.uploads[0]!.filename).toBe(name);
  });

  it('removes the staging area when the upload fails', async () => {
    const p = join(dir, 'missing-after.mp4');
    await writeFile(p, Buffer.alloc(8));
    // Force the PUT to 404 by destroying the staging area mid-flight.
    const original = client.createStagingArea.bind(client);
    client.createStagingArea = async () => {
      const uuid = await original();
      mock.state.stagingAreas.delete(uuid);
      return uuid;
    };
    await expect(uploadFile(client, p, 'missing-after.mp4')).rejects.toThrow();
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('verifies a larger, non-round byte count is transmitted in full', async () => {
    // Catches chunking/truncation bugs that a small, round-number buffer
    // (e.g. exactly one chunk) could hide.
    const size = 1024 * 1024 + 7;
    const p = join(dir, 'big.mp4');
    await writeFile(p, Buffer.alloc(size, 3));
    const staging = await uploadFile(client, p, 'big.mp4');
    expect(mock.state.uploads).toEqual([{ staging, filename: 'big.mp4', bytes: size }]);
  });

  it('retries exactly once, with a fresh staging area and body, when the token expires mid-upload', async () => {
    // The client invalidates the token and throws a non-replayable-stream
    // 401 rather than silently re-sending a drained body. upload.ts owns
    // "how do I get a fresh body" -- it must catch that 401, delete the
    // dead staging area, open a brand-new stream, and retry once against a
    // fresh staging area (the retried request now carries a fresh token).
    mock.state.expireNext = 1;
    const size = 4096;
    const p = join(dir, 'clip.mp4');
    await writeFile(p, Buffer.alloc(size, 9));

    const staging = await uploadFile(client, p, 'clip.mp4');

    // Exactly one successful upload, carrying the FULL byte count -- not 0,
    // and not a partial write from a drained stream.
    expect(mock.state.uploads).toEqual([{ staging, filename: 'clip.mp4', bytes: size }]);
    // The first (failed) staging area must not be left behind; only the
    // one backing the successful retry should remain.
    expect(mock.state.stagingAreas.size).toBe(1);
    expect(mock.state.stagingAreas.has(staging)).toBe(true);
  });

  it('propagates a second consecutive 401 rather than retrying forever', async () => {
    mock.state.expireNext = 2;
    const p = join(dir, 'clip.mp4');
    await writeFile(p, Buffer.alloc(64));
    const err = await uploadFile(client, p, 'clip.mp4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(mock.state.uploads.length).toBe(0);
    // No staging area leaked from either the first or the retried attempt.
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('cleans up the staging area when the local file does not exist', async () => {
    const p = join(dir, 'does-not-exist.mp4');
    await expect(uploadFile(client, p, 'does-not-exist.mp4')).rejects.toThrow();
    expect(mock.state.stagingAreas.size).toBe(0);
    expect(mock.state.uploads.length).toBe(0);
  });

  it('rejects a zero-byte source file up front, without leaking a staging area', async () => {
    // A 0-byte file would "succeed" and produce an empty attachment, which
    // breaks the tool's 1-file:1-attachment contract silently. Reject it
    // before ever talking to the server, so the failure is loud and no
    // staging area is created and abandoned for it.
    const p = join(dir, 'empty.mp4');
    await writeFile(p, Buffer.alloc(0));
    const err = await uploadFile(client, p, 'empty.mp4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(mock.state.stagingAreas.size).toBe(0);
    expect(mock.state.uploads.length).toBe(0);
  });
});
