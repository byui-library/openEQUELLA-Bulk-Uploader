import { readFile, unlink, writeFile } from 'node:fs/promises';
import { OeqError } from './errors.js';

/**
 * Cross-process advisory lock for a single manifest file.
 *
 * Lives in its own module (rather than inline in runner.ts) because it is a
 * distinct, independently testable concern -- pid liveness checking and a
 * lock-file's read/write/reclaim lifecycle -- that both the runner (Task 10)
 * and the MCP server (Task 12: `oeq_plan`, `oeq_retry_failed`, the CLI
 * `retry` command) need to consult. Keeping it separate lets those callers
 * import `checkLock` without pulling in the runner's upload/retry machinery.
 *
 * WHY THIS EXISTS: `state.ts`'s `saveManifest` makes each individual write
 * atomic and durable, but gives no cross-process protection for a
 * load-modify-save *cycle*. The MCP server spawns the runner detached, while
 * `oeq_plan` and `oeq_retry_failed` also read-modify-write the same manifest.
 * A retry invoked mid-run would serialize its own stale in-memory snapshot
 * over the runner's progress -- reverting a `created` entry back to
 * `pending` and causing a duplicate ~150 MB upload on the next run. This
 * lock exists to make that race loud (a clear error naming the owning pid)
 * instead of silent data loss.
 */
export interface LockInfo {
  pid: number;
  startedAt: string;
}

function lockPath(manifestPath: string): string {
  return `${manifestPath}.lock`;
}

/**
 * Is the process identified by `pid` currently alive? Works on both Windows
 * and POSIX: `process.kill(pid, 0)` sends no signal, it only probes.
 *   - ESRCH: no such process -- definitively gone.
 *   - EPERM: the process exists but we lack permission to signal it -- still
 *     alive, just not ours; must NOT be treated as stale.
 *   - anything else (unexpected): treated conservatively as alive, so an
 *     ambiguous probe failure never causes a live run's lock to be reclaimed
 *     out from under it.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

async function readLockInfo(path: string): Promise<LockInfo | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number') return null;
    return { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '' };
  } catch {
    // A corrupt/truncated lock file (e.g. from a crash mid-write) is not
    // proof of a live run -- treat it the same as "no lock" rather than
    // wedging the job forever over an unreadable file.
    return null;
  }
}

/**
 * Returns the current lock holder's info, or null if there is no lock, the
 * lock file is corrupt, or the owning pid is no longer running (stale).
 * Never throws for a missing/corrupt lock file. This is the helper the MCP
 * server (Task 12) calls to check "is a run in progress" without starting
 * one, so `oeq_plan` / `oeq_retry_failed` / the CLI `retry` command can
 * refuse to write while a live lock exists.
 */
export async function checkLock(manifestPath: string): Promise<LockInfo | null> {
  const info = await readLockInfo(lockPath(manifestPath));
  if (!info || !isProcessAlive(info.pid)) return null;
  return info;
}

/**
 * Acquire the run lock for `manifestPath`. Throws a clear, pid-naming error
 * if a live lock already exists; silently reclaims a stale one (owning pid
 * no longer running) so a killed runner never wedges the job permanently.
 *
 * The initial write uses the exclusive-create flag ('wx') so two processes
 * racing to acquire a *fresh* lock can't both succeed -- the loser gets
 * EEXIST and falls through to the liveness check below. This does not
 * make reclaiming a stale lock fully race-free across processes (that would
 * need a platform-level file lock), but that residual window is
 * intentionally accepted: this tool has a single human operator driving one
 * MCP server / CLI at a time, and the goal here is to catch the ordinary
 * "forgot a run was still going" mistake loudly, not to defend against
 * adversarial concurrent operators.
 */
export async function acquireLock(manifestPath: string): Promise<void> {
  const path = lockPath(manifestPath);
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };

  try {
    await writeFile(path, JSON.stringify(info), { encoding: 'utf8', flag: 'wx' });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const existing = await readLockInfo(path);
  if (existing && isProcessAlive(existing.pid)) {
    throw new OeqError(
      `Manifest ${manifestPath} is locked by process ${existing.pid}` +
        (existing.startedAt ? ` (started ${existing.startedAt})` : '') +
        `. Another run may already be in progress against this manifest; wait for it to ` +
        `finish. If that process is definitely gone, delete ${path} and try again.`,
    );
  }

  // Stale (dead pid) or corrupt lock file: reclaim it.
  await writeFile(path, JSON.stringify(info), 'utf8');
}

/** Release the run lock. Idempotent: a missing lock file is not an error. */
export async function releaseLock(manifestPath: string): Promise<void> {
  try {
    await unlink(lockPath(manifestPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
