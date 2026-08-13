import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaCache } from '../src/core/schemaCache.js';
import type { SchemaInfo } from '../src/core/discovery.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-schema-cache-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const info: SchemaInfo = {
  uuid: 'c93181f3-a443-41bf-9afe-ac9f7daf90b7',
  namePath: '/MWDL/title',
  titleHeader: 'MWDL/title',
  descriptionPath: '/MWDL/description',
  descriptionHeader: 'MWDL/description',
  paths: new Set(['MWDL/title', 'MWDL/description']),
};

/** The single file this cache wrote, for tests that need to damage it. */
async function onlyFile(): Promise<string> {
  const names = await readdir(dir);
  expect(names).toHaveLength(1);
  return join(dir, names[0]!);
}

describe('SchemaCache', () => {
  /**
   * `paths` is a Set, which JSON.stringify turns into `{}` -- so a naive
   * round-trip loses every valid xpath while still producing a plausible
   * object. Asserting on a member, not just on truthiness, is the point.
   */
  it('round-trips a schema, including the path set and the title header', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://oeq.example.edu', info);
    const loaded = await cache.load('https://oeq.example.edu', info.uuid);

    expect(loaded).not.toBeNull();
    expect(loaded!.uuid).toBe(info.uuid);
    expect(loaded!.namePath).toBe('/MWDL/title');
    expect(loaded!.titleHeader).toBe('MWDL/title');
    // The starter profile's description column is proposed from this. Losing it
    // in the cache would mean an operator working offline gets no description
    // column at all, from a schema that declares one.
    expect(loaded!.descriptionPath).toBe('/MWDL/description');
    expect(loaded!.descriptionHeader).toBe('MWDL/description');
    expect(loaded!.paths).toBeInstanceOf(Set);
    expect(loaded!.paths.has('MWDL/description')).toBe(true);
    expect(loaded!.paths.size).toBe(2);
  });

  /**
   * A file written before the description path was cached at all has neither
   * key. Refusing it would throw away a perfectly good schema -- sending
   * extraction back to the bundled export -- over a field whose "not declared"
   * answer is null anyway.
   */
  it('reads a cache file written before the description path existed', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://oeq.example.edu', info);
    await writeFile(
      await onlyFile(),
      JSON.stringify({
        uuid: info.uuid,
        namePath: '/MWDL/title',
        titleHeader: 'MWDL/title',
        paths: ['MWDL/title'],
      }),
      'utf8',
    );

    const loaded = await cache.load('https://oeq.example.edu', info.uuid);
    expect(loaded).not.toBeNull();
    expect(loaded!.titleHeader).toBe('MWDL/title');
    expect(loaded!.descriptionHeader).toBeNull();
  });

  /**
   * Schema uuids are not globally unique across institutions, and one
   * institution's test and production instances routinely share them
   * outright (see config.ts). Keying on the uuid alone would let one site's
   * schema answer for another's -- silently, and with paths that look real.
   */
  it('keeps instances separate so two sites cannot answer for each other', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://a.example.edu', info);

    expect(await cache.load('https://b.example.edu', info.uuid)).toBeNull();
    expect(await cache.load('https://a.example.edu', info.uuid)).not.toBeNull();
  });

  /**
   * Extraction must still run with no cache -- blocking the offline half of
   * the tool on a network call the operator did not ask for would trade a
   * real capability for a check.
   */
  it('returns null rather than throwing when nothing is cached', async () => {
    await expect(new SchemaCache(dir).load('https://oeq.example.edu', 'nope')).resolves.toBeNull();
  });

  it('returns null rather than throwing when the cache directory does not exist', async () => {
    const cache = new SchemaCache(join(dir, 'never-created'));
    await expect(cache.load('https://oeq.example.edu', info.uuid)).resolves.toBeNull();
  });

  it('returns null rather than throwing on a corrupt cache file', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://oeq.example.edu', info);
    await writeFile(await onlyFile(), 'not json', 'utf8');

    await expect(cache.load('https://oeq.example.edu', info.uuid)).resolves.toBeNull();
  });

  /**
   * Valid JSON of the wrong shape is the dangerous case: it parses, so a
   * cache that only guards against a parse error would hand back a
   * SchemaInfo with an empty `paths` set. An empty set does not read as
   * "unknown" downstream -- it reads as "this schema declares no valid
   * columns", which would reject every column an operator extracted.
   */
  it('returns null rather than throwing on valid JSON of the wrong shape', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://oeq.example.edu', info);
    const file = await onlyFile();

    await writeFile(file, JSON.stringify({ hello: 'world' }), 'utf8');
    await expect(cache.load('https://oeq.example.edu', info.uuid)).resolves.toBeNull();

    // A `paths` that is present but not an array is the same failure.
    await writeFile(
      file,
      JSON.stringify({ uuid: info.uuid, namePath: null, titleHeader: null, paths: 'MWDL/title' }),
      'utf8',
    );
    await expect(cache.load('https://oeq.example.edu', info.uuid)).resolves.toBeNull();

    // So is a top-level array, or a bare JSON scalar.
    await writeFile(file, JSON.stringify(['MWDL/title']), 'utf8');
    await expect(cache.load('https://oeq.example.edu', info.uuid)).resolves.toBeNull();
    await writeFile(file, 'null', 'utf8');
    await expect(cache.load('https://oeq.example.edu', info.uuid)).resolves.toBeNull();
  });

  /**
   * A schema that declares no name path is a real answer, not a missing one
   * (see discovery.ts#parseSchema) -- so null must survive the round trip
   * rather than being treated as an absent field.
   */
  it('round-trips a schema that declares no name path', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://oeq.example.edu', {
      uuid: 's-1',
      namePath: null,
      titleHeader: null,
      descriptionPath: null,
      descriptionHeader: null,
      paths: new Set(['Local/title']),
    });

    const loaded = await cache.load('https://oeq.example.edu', 's-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.namePath).toBeNull();
    expect(loaded!.titleHeader).toBeNull();
    expect(loaded!.paths.has('Local/title')).toBe(true);
  });

  it('overwrites the previous entry for the same instance and schema', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://oeq.example.edu', info);
    await cache.save('https://oeq.example.edu', { ...info, paths: new Set(['MWDL/title']) });

    const loaded = await cache.load('https://oeq.example.edu', info.uuid);
    expect(loaded!.paths.size).toBe(1);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('creates its directory on save rather than requiring the caller to', async () => {
    const nested = join(dir, 'a', 'b');
    const cache = new SchemaCache(nested);
    await cache.save('https://oeq.example.edu', info);

    expect(await cache.load('https://oeq.example.edu', info.uuid)).not.toBeNull();
  });
});
