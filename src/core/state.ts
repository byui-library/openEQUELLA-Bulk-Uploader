import { readFile, rename, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Manifest, ItemState } from './types.js';
import { OeqError } from './errors.js';

/**
 * Write atomically: a crash mid-write must never leave a truncated manifest,
 * because the manifest is the only record of which items already exist.
 *
 * The temp file name includes the pid and a random uuid so two overlapping
 * `saveManifest` calls never share a temp path. Without that, two writers
 * racing on a fixed `${path}.tmp` could interleave writes to the same path
 * (each `writeFile` call opens its own handle) and rename a half-written file
 * into place, corrupting the one record of which items already exist.
 *
 * PRECONDITION — this module gives no cross-process update protection.
 * It makes each individual write atomic and durable; it does NOT serialise
 * load-modify-save cycles. Callers must not run overlapping cycles against the
 * same manifest path from independent processes. That is a live hazard rather
 * than a theoretical one: `oeq_start_job` spawns the runner detached, while
 * `oeq_plan` and `oeq_retry_failed` also write. A retry invoked mid-run would
 * serialise its own stale in-memory snapshot over the runner's progress,
 * reverting a `created` entry to `pending` and causing a duplicate 150 MB
 * upload on resume. Guarding that belongs in the runner and the MCP server.
 *
 * The temp file is fsync'd (via a file handle's `sync()`) before the rename.
 * `rename` is atomic with respect to *visibility* — a reader never observes a
 * half-renamed file — but atomicity says nothing about durability: the old
 * data may still be sitting in the OS page cache when the process is killed
 * or the machine loses power, and a rename can itself be reordered before
 * its data hits disk without an fsync. This tool's entire premise is
 * surviving exactly that kind of interruption (dropped laptops, killed
 * processes), and the manifest is tiny (dozens of KB) and saved on the order
 * of ~74 times per run, so the fsync's cost (a few milliseconds) is
 * negligible next to the multi-minute per-file uploads it's guarding.
 *
 * On Windows, renaming onto an existing destination is implemented as an
 * NTFS delete-then-create under the hood; two renames landing on the same
 * destination path at almost the same instant can transiently collide with
 * EPERM/EBUSY even though each temp file is unique and each rename is
 * individually atomic — this is a real, observed OS-level race (not a flaw
 * in the unique-temp-name design above), so it's retried a few times with a
 * short backoff rather than surfaced as a hard failure.
 */
export async function saveManifest(path: string, manifest: Manifest): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(manifest, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(tmp, path);
}

/** Retries a transient Windows rename-collision (see saveManifest doc above). */
async function renameWithRetry(tmp: string, path: string, attempt = 0): Promise<void> {
  try {
    await rename(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const transient = code === 'EPERM' || code === 'EBUSY';
    if (!transient || attempt >= 5) throw err;
    await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    await renameWithRetry(tmp, path, attempt + 1);
  }
}

/**
 * Shallow structural check for the fields the runner (and MCP server)
 * directly depend on. Hand-rolled rather than a zod schema: the failure mode
 * we're guarding against is a corrupt/truncated/hand-edited manifest file,
 * and the useful response is "name the field, say what's wrong, stop" — a
 * handful of `typeof`/`Array.isArray` checks says that as clearly as a zod
 * schema would, without pulling in a dependency graph or committing to
 * validating every entry field (which risks becoming exhaustive shape
 * validation nobody asked for, and drifting out of sync with `types.ts`
 * whenever that file changes). This deliberately does not descend into each
 * `ManifestEntry` — TypeScript already gives us that at the write site, and
 * corruption there fails later with an entry-specific error instead of a
 * load-time one, which is an acceptable trade for keeping this check small.
 */
function validateStructure(value: unknown, path: string): asserts value is Manifest {
  if (typeof value !== 'object' || value === null) {
    throw new OeqError(`Manifest at ${path} is not a JSON object.`);
  }
  const m = value as Record<string, unknown>;

  if (m['version'] !== 1) {
    throw new OeqError(
      `Unsupported manifest version ${JSON.stringify(m['version'])} in ${path}; expected 1. ` +
        `This manifest may be from an incompatible version of the tool; do not resume with it.`,
    );
  }
  if (!Array.isArray(m['entries'])) {
    throw new OeqError(
      `Manifest at ${path} is missing an 'entries' array; the file is corrupt or was not ` +
        `produced by this tool. Do not resume with it.`,
    );
  }
  if (typeof m['collectionUuid'] !== 'string' || m['collectionUuid'].length === 0) {
    throw new OeqError(
      `Manifest at ${path} is missing a non-empty 'collectionUuid'; the file is corrupt or ` +
        `was not produced by this tool.`,
    );
  }
  const validStates: ItemState[] = ['draft', 'published'];
  if (!validStates.includes(m['itemState'] as ItemState)) {
    throw new OeqError(
      `Manifest at ${path} has an invalid 'itemState' (${JSON.stringify(m['itemState'])}); ` +
        `expected 'draft' or 'published'.`,
    );
  }
}

export async function loadManifest(path: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? `No manifest found at ${path}. Run the plan step first, or check the --job path.`
        : `Could not read manifest at ${path}: ${(err as Error).message}`;
    throw new OeqError(message, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OeqError(
      `Manifest at ${path} is not valid JSON (${(err as Error).message}). It may be truncated ` +
        `from an interrupted write; check for a backup or re-run the plan step.`,
      { cause: err },
    );
  }

  validateStructure(parsed, path);
  return parsed;
}
