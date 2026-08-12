import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { SchemaInfo } from './discovery.js';

/**
 * Holds a fetched schema on disk so `src/core/extract/` can validate the
 * columns it produces without a network call.
 *
 * EXTRACTION BEING OFFLINE IS THE POINT. An operator builds a spreadsheet from
 * a folder of files without signing in to anything (see CLAUDE.md); that is a
 * real, load-bearing capability, not an implementation detail. The schema
 * moving onto the API would otherwise force a choice between extraction
 * gaining a network call and extraction losing column validation. This is the
 * third option: whoever DID sign in leaves the schema here, and extraction
 * reads it later, offline.
 *
 * KEYED ON THE INSTANCE URL AS WELL AS THE SCHEMA UUID. Schema uuids are not
 * globally unique across institutions, and one institution's test and
 * production instances routinely share them outright -- the same reason
 * `tokenStore.ts` stores `baseUrl` beside the token. Keying on the uuid alone
 * would let one site's schema answer for another's, silently, with paths that
 * look entirely real.
 *
 * EVERY READ FAILURE RETURNS NULL AND NEVER THROWS -- missing, unreadable,
 * unparseable, or valid JSON of the wrong shape. A missing or damaged cache
 * must degrade to "columns unvalidated", never to "extraction refused":
 * blocking the offline half of the tool on a network call the operator did not
 * ask for would trade a real capability for a check. Wrong-shape is checked as
 * carefully as unparseable because it is the more dangerous of the two -- it
 * parses, so an unguarded load would hand back a SchemaInfo with an empty
 * `paths` set, and empty does not read as "unknown" downstream. It reads as
 * "this schema declares no valid columns", which would reject every column
 * the operator extracted.
 */
export class SchemaCache {
  constructor(private readonly dir: string) {}

  /**
   * One file per (instance, schema) pair. The name is a hash rather than the
   * values themselves because an instance URL is not a legal filename and a
   * schema uuid is only accidentally one; the hash also keeps the length
   * fixed, which matters on Windows.
   */
  private file(instanceUrl: string, schemaUuid: string): string {
    // Joined with a newline, which can appear in neither a URL nor a uuid, so
    // ('https://a.edu/x', 'y') and ('https://a.edu', 'x/y') cannot collide.
    const key = createHash('sha256')
      .update(`${instanceUrl}\n${schemaUuid}`)
      .digest('hex')
      .slice(0, 32);
    return join(this.dir, `schema-${key}.json`);
  }

  /**
   * `paths` is a Set, which `JSON.stringify` renders as `{}` -- every valid
   * xpath would be lost while the file still looked plausible. Stored as an
   * array and rebuilt on load.
   */
  async save(instanceUrl: string, schema: SchemaInfo): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const payload = {
      uuid: schema.uuid,
      namePath: schema.namePath,
      titleHeader: schema.titleHeader,
      paths: [...schema.paths],
    };
    await writeFile(this.file(instanceUrl, schema.uuid), JSON.stringify(payload, null, 2), 'utf8');
  }

  async load(instanceUrl: string, schemaUuid: string): Promise<SchemaInfo | null> {
    let text: string;
    try {
      text = await readFile(this.file(instanceUrl, schemaUuid), 'utf8');
    } catch {
      // Missing file, missing directory, unreadable -- there is no cached
      // schema, which is a legitimate state and not an error.
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    return toSchemaInfo(parsed);
  }
}

/** Null unless every field is present and of the right type -- see the class doc. */
function toSchemaInfo(parsed: unknown): SchemaInfo | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  if (typeof raw.uuid !== 'string') return null;
  if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== 'string')) return null;
  // null is a real answer here, not an absent field: a schema that declares no
  // item name path is exactly what `findDuplicates` must be told about.
  if (raw.namePath !== null && typeof raw.namePath !== 'string') return null;
  if (raw.titleHeader !== null && typeof raw.titleHeader !== 'string') return null;

  return {
    uuid: raw.uuid,
    namePath: raw.namePath,
    titleHeader: raw.titleHeader,
    paths: new Set(raw.paths as string[]),
  };
}
