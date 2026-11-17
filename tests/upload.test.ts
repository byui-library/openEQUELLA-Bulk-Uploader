import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadFiles } from '../src/core/upload.js';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { ApiError, ValidationError } from '../src/core/errors.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

// A single-file row, as plan builds one with no recorded size.
const single = (path: string, name: string) => ({ source: name, files: [{ path, name }] });

/**
 * Every real `fs.ReadStream` upload.ts opens, captured so the fd-leak test
 * below can assert on it directly rather than guessing at leaked handles
 * from the outside. `vi.hoisted` is required (not a plain top-level
 * `const`) because `vi.mock` factories are hoisted above this file's own
 * imports, so a variable they close over must be initialised before that
 * hoisting point.
 */
const { openedReadStreams } = vi.hoisted(() => ({ openedReadStreams: [] as ReadStream[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      openedReadStreams.push(stream);
      return stream;
    },
  };
});

/** Poll until a Node stream reports closed, or fail after ~2s. */
async function waitForClosed(stream: { closed: boolean }): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!stream.closed) {
    if (Date.now() > deadline) throw new Error('stream never closed');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let mock: MockServer;
let client: OeqClient;
let dir: string;

beforeEach(async () => {
  mock = await startMockServer();
  client = new OeqClient(mock.url, new OAuthClientCredentials(mock.url, 'good-id', 'secret'));
  dir = await mkdtemp(join(tmpdir(), 'oeq-up-'));
  openedReadStreams.length = 0;
});
afterEach(async () => {
  await mock.close();
});

describe('uploadFiles -- one file', () => {
  it('streams the file into a staging area', async () => {
    const p = join(dir, 'clip.mp4');
    await writeFile(p, Buffer.alloc(4096, 7));
    const staging = await uploadFiles(client, single(p, 'clip.mp4'));
    expect(mock.state.uploads).toEqual([{ staging, filename: 'clip.mp4', bytes: 4096 }]);
  });

  it('preserves commas and spaces in the filename', async () => {
    const name = 'Aster, Juniper 010125.MP4';
    const p = join(dir, name);
    await writeFile(p, Buffer.alloc(16));
    await uploadFiles(client, single(p, name));
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
    await expect(uploadFiles(client, single(p, 'missing-after.mp4'))).rejects.toThrow();
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('verifies a larger, non-round byte count is transmitted in full', async () => {
    // Catches chunking/truncation bugs that a small, round-number buffer
    // (e.g. exactly one chunk) could hide.
    const size = 1024 * 1024 + 7;
    const p = join(dir, 'big.mp4');
    await writeFile(p, Buffer.alloc(size, 3));
    const staging = await uploadFiles(client, single(p, 'big.mp4'));
    expect(mock.state.uploads).toEqual([{ staging, filename: 'big.mp4', bytes: size }]);
  });

  it('retries exactly once, with a fresh staging area and body, when the token expires mid-upload', async () => {
    // Targets the 401 at the PUT specifically (via expireNextUpload, a
    // test-only knob on the mock -- see its header comment), not the
    // generic expireNext, which would be consumed by the POST
    // /api/staging that createStagingArea() issues just before the PUT
    // and never actually reach the upload whose body is a one-shot
    // stream. That would let a broken implementation that reuses the
    // same drained stream across both attempts pass this test for the
    // wrong reason.
    //
    // The client invalidates the token and throws a non-replayable-stream
    // 401 rather than silently re-sending a drained body. upload.ts owns
    // "how do I get a fresh body" -- it must catch that 401, delete the
    // dead staging area, open a brand-new stream, and retry once against a
    // fresh staging area (the retried request now carries a fresh token).
    mock.state.expireNextUpload = 1;
    const size = 4096;
    const p = join(dir, 'clip.mp4');
    await writeFile(p, Buffer.alloc(size, 9));

    const staging = await uploadFiles(client, single(p, 'clip.mp4'));

    // Exactly one successful upload, carrying the FULL byte count -- not 0,
    // and not a partial write from a drained stream.
    expect(mock.state.uploads).toEqual([{ staging, filename: 'clip.mp4', bytes: size }]);
    // The first (failed) staging area must not be left behind; only the
    // one backing the successful retry should remain.
    expect(mock.state.stagingAreas.size).toBe(1);
    expect(mock.state.stagingAreas.has(staging)).toBe(true);
  });

  it('propagates a second consecutive 401 rather than retrying forever', async () => {
    // Both the original attempt's PUT and the retry's PUT are targeted, so
    // this actually exercises two real upload attempts rather than two
    // staging-area creations.
    mock.state.expireNextUpload = 2;
    const p = join(dir, 'clip.mp4');
    await writeFile(p, Buffer.alloc(64));
    const err = await uploadFiles(client, single(p, 'clip.mp4')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(mock.state.uploads.length).toBe(0);
    // No staging area leaked from either the first or the retried attempt.
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('cleans up the staging area when the local file does not exist', async () => {
    const p = join(dir, 'does-not-exist.mp4');
    await expect(uploadFiles(client, single(p, 'does-not-exist.mp4'))).rejects.toThrow();
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
    const err = await uploadFiles(client, single(p, 'empty.mp4')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(mock.state.stagingAreas.size).toBe(0);
    expect(mock.state.uploads.length).toBe(0);
  });

  it('cleans up when the file vanishes between the size check and opening the stream', async () => {
    // uploadFiles()'s upfront stat() is not atomic with uploadOnce() later
    // opening the stream -- createStagingArea() in between is a real
    // network round trip. Simulate the file disappearing in exactly that
    // window and confirm the resulting ENOENT (surfaced asynchronously via
    // the stream's 'error' event during fetch, not a synchronous throw)
    // still results in the staging area being cleaned up.
    const p = join(dir, 'vanishes.mp4');
    await writeFile(p, Buffer.alloc(64));
    const original = client.createStagingArea.bind(client);
    client.createStagingArea = async () => {
      const uuid = await original();
      await rm(p);
      return uuid;
    };
    const err = await uploadFiles(client, single(p, 'vanishes.mp4')).catch((e: unknown) => e);
    expect(err).toBeTruthy();
    expect(mock.state.stagingAreas.size).toBe(0);
    expect(mock.state.uploads.length).toBe(0);
  });

  it('destroys the file handle when the upload fails partway through', async () => {
    // client.request() throws on a non-ok response without draining or
    // closing whatever body it was given -- it has no notion that the
    // body was backed by a file handle. A small fixture (the 8-byte one
    // used elsewhere) can finish streaming, get buffered, and close before
    // the failure even registers, masking a leak; a file large enough to
    // still be mid-flight when the mock server's 404 response arrives is
    // required to expose it. 5 MB is comfortably larger than what fits in
    // a single localhost round trip.
    const p = join(dir, 'big-fail.mp4');
    await writeFile(p, Buffer.alloc(5 * 1024 * 1024, 1));

    // Force the PUT to 404 by destroying the staging area mid-flight, same
    // trick as the "removes the staging area when the upload fails" test
    // above, but with a file big enough to still be streaming when the
    // response arrives -- the mock's PUT handler checks for the staging
    // area and responds 404 *before* ever reading the request body, so the
    // outgoing 5 MB body is aborted mid-transfer, not drained cleanly.
    const original = client.createStagingArea.bind(client);
    client.createStagingArea = async () => {
      const uuid = await original();
      mock.state.stagingAreas.delete(uuid);
      return uuid;
    };

    await expect(uploadFiles(client, single(p, 'big-fail.mp4'))).rejects.toThrow();
    expect(mock.state.stagingAreas.size).toBe(0);

    // The real assertion: the actual fs.ReadStream upload.ts opened (via
    // the node:fs mock above) must have been destroyed, not left dangling
    // holding the fd open for the rest of the process's life.
    expect(openedReadStreams.length).toBe(1);
    const stream = openedReadStreams[0]!;
    await waitForClosed(stream);
    expect(stream.destroyed).toBe(true);
  });
});

describe('uploadFiles -- folder rows', () => {
  async function folderOf(files: Record<string, string>) {
    const f = join(dir, 'V2');
    await mkdir(f);
    for (const [n, b] of Object.entries(files)) await writeFile(join(f, n), b);
    return {
      source: 'V2',
      folderPath: f,
      files: Object.entries(files).map(([name, b]) => ({ path: join(f, name), name, size: b.length })),
    };
  }

  it('puts every file into ONE staging area, in manifest order', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': 'bb', 'No3.pdf': 'ccc' });
    const staging = await uploadFiles(client, unit);
    expect(mock.state.uploads).toEqual([
      { staging, filename: 'No1.pdf', bytes: 1 },
      { staging, filename: 'No2.pdf', bytes: 2 },
      { staging, filename: 'No3.pdf', bytes: 3 },
    ]);
  });

  it('a 401 on the second file restarts the WHOLE row in a fresh staging area', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': 'bb' });
    mock.state.expireNextUploadAfter = 1;
    const staging = await uploadFiles(client, unit);
    // The first area got No1 and then lost No2; the retry has both.
    expect(mock.state.uploads.filter((u) => u.staging === staging).map((u) => u.filename)).toEqual([
      'No1.pdf',
      'No2.pdf',
    ]);
    expect([...mock.state.stagingAreas]).toEqual([staging]);
  });

  it('propagates a second 401 within the same row', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': 'bb' });
    // The first PUT of each attempt is refused: the retry fails too, and stops.
    mock.state.expireNextUpload = 2;
    const err = await uploadFiles(client, unit).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('fails the row when the folder gained a file since planning, creating nothing', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a' });
    await writeFile(join(unit.folderPath, 'No2.pdf'), 'x');
    await expect(uploadFiles(client, unit)).rejects.toThrow(
      "the folder changed since planning ('No2.pdf' was added); plan again",
    );
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('fails the row when a file changed size, naming both sizes', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a' });
    await writeFile(join(unit.folderPath, 'No1.pdf'), 'abcd');
    await expect(uploadFiles(client, unit)).rejects.toThrow(
      "'No1.pdf' changed size (1 bytes when planned, 4 now)",
    );
  });

  it('fails the row when a file is missing', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': 'b' });
    await rm(join(unit.folderPath, 'No2.pdf'));
    await expect(uploadFiles(client, unit)).rejects.toThrow("'No2.pdf' is missing");
  });

  it('fails the row when a folder has appeared inside it', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a' });
    await mkdir(join(unit.folderPath, 'extra'));
    await expect(uploadFiles(client, unit)).rejects.toThrow(/the folder changed since planning \(it holds a folder/);
  });

  it('refuses a 0-byte file in a folder, naming it, before creating anything', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': '' });
    await expect(uploadFiles(client, unit)).rejects.toThrow(/No2\.pdf.*0 bytes/);
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('checks presence only when no size was recorded (a v1 manifest)', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a' });
    delete (unit.files[0] as { size?: number }).size;
    await writeFile(join(unit.folderPath, 'No1.pdf'), 'abcd');
    await expect(uploadFiles(client, unit)).resolves.toBeTypeOf('string');
  });

  it('fails a single-file row whose file changed size since planning', async () => {
    const p = join(dir, 'one.pdf');
    await writeFile(p, 'abcd');
    const unit = { source: 'one.pdf', files: [{ path: p, name: 'one.pdf', size: 1 }] };
    await expect(uploadFiles(client, unit)).rejects.toThrow(
      "'one.pdf' changed since planning (1 bytes when planned, 4 now); plan again",
    );
  });
});

describe('uploadFiles -- staging path encoding', () => {
  // A filename travels in the staging PUT's URL path. Each of these, sent
  // raw, would change what the server sees: '&' and '%' break decoding, '#'
  // truncates at a fragment, '?' starts a query. client.ts encodes the
  // segment; these pin it.
  it.each(['A & B.pdf', 'No #3.pdf', '100% done.pdf', 'No2&3.pdf'])(
    'the server receives %s whole',
    async (name) => {
      const p = join(dir, name);
      await writeFile(p, 'x');
      await uploadFiles(client, single(p, name));
      expect(mock.state.uploads.at(-1)!.filename).toBe(name);
    },
  );

  // '?' cannot be in a Windows filename, so the file on disk has another
  // name; the attachment name is what travels in the URL.
  it('the server receives a ? whole', async () => {
    const p = join(dir, 'q.pdf');
    await writeFile(p, 'x');
    await uploadFiles(client, single(p, 'what?.pdf'));
    expect(mock.state.uploads.at(-1)!.filename).toBe('what?.pdf');
  });
});
