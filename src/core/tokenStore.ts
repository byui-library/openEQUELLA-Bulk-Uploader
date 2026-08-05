import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * What gets persisted for the authorization-code flow (`authCode.ts`).
 *
 * `baseUrl` is the guard that stops a token minted against the test instance
 * from being used against production: the collection UUID is identical on
 * both, so `baseUrl` is the only thing that distinguishes them. `expiresAt`
 * is an absolute epoch-ms timestamp, computed once at exchange time from the
 * server's `expires_in` (if it sent one) -- not re-derived later, so a clock
 * change on this machine can't retroactively change what "expired" means.
 */
export interface StoredToken {
  accessToken: string;
  baseUrl: string;
  expiresAt?: number;
}

/**
 * Storage for a token acquired interactively so a detached process (the
 * runner, spawned by the CLI) can pick it up without the operator having to
 * re-export an env var per command.
 *
 * NOTE ON RISK: this stores a bearer credential at rest, in a plaintext JSON
 * file.
 *
 * An earlier version of this comment called the token "short-lived (server-set
 * `expires_in`, typically well under a day)". That is FALSE for this instance,
 * measured 2026-08-04: content-test.byui.edu returns
 * `expires_in: 9223372036854775807` -- Long.MAX_VALUE, i.e. the token does not
 * expire. So the mitigating factor is only that it is user-scoped (it
 * authenticates as whoever ran the login flow, not a shared service account);
 * the time window is effectively unbounded, and `oeq-upload logout` after a
 * session is genuinely worth doing rather than merely tidy.
 *
 * The `expiresAt` handling below is retained because it is correct if any
 * instance ever does set a real `expires_in`, and because refusing an expired
 * token is the safe direction to be wrong in. It is simply inert here. The
 * alternative -- printing the token and asking the operator to `export` it
 * before every command -- was judged worse for usability for no real
 * security gain: an env var is just as readable to anything else running as
 * the same OS user, and is easier to accidentally paste into a shell history
 * or a support ticket than a gitignored file this tool manages itself.
 */
export interface TokenStore {
  /** Persist a token, overwriting whatever was stored before. */
  save(data: StoredToken): Promise<void>;
  /**
   * Return the token usable for `baseUrl` right now, or null if there is
   * none -- whether because nothing was ever saved, because what's saved
   * was issued for a different instance, or because it has expired. A
   * caller that just wants "a token I can use" only needs this method;
   * `loadRaw()` exists separately for a caller (e.g. `authCode.ts`'s error
   * messages) that wants to explain *why* there wasn't one.
   */
  load(baseUrl: string): Promise<string | null>;
  /** The raw stored record, if any and if well-formed, with no baseUrl or expiry validation. */
  loadRaw(): Promise<StoredToken | null>;
  /** Remove any persisted token. */
  clear(): Promise<void>;
  /**
   * Synchronous equivalent of `clear()`, used only by
   * `AuthorizationCodeAuth.invalidate()`. `AuthProvider.invalidate()` (see
   * auth.ts) returns `void`, not `Promise<void>` -- and `client.ts` calls it
   * without awaiting, then immediately retries the request in the same tick.
   * A fire-and-forget `clear()` there would race that immediate retry's
   * `getToken()` call: whether it sees the file already gone would depend on
   * unpredictable fs completion ordering, making "the next call fails fast"
   * a coin flip instead of a guarantee. Deleting one small JSON file
   * synchronously is cheap and removes the race entirely.
   */
  clearSync(): void;
}

/**
 * Default location: `.oeq-token.json` in the current working directory --
 * i.e. wherever the operator runs `oeq-upload` from. It is gitignored.
 *
 * Kept injectable (the constructor takes the path) so tests never touch a
 * real file in the repo, and so a caller can point it elsewhere entirely if
 * cwd turns out to be the wrong call in practice.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly filePath: string = '.oeq-token.json') {}

  /** Where this store reads/writes -- for operator-facing messages (e.g. `login`'s output). */
  get path(): string {
    return this.filePath;
  }

  async save(data: StoredToken): Promise<void> {
    const dir = dirname(this.filePath);
    if (dir && dir !== '.') {
      await mkdir(dir, { recursive: true });
    }
    // Write-to-temp-then-rename: a crash mid-write must never leave a
    // truncated/corrupt token file. Deliberately lighter-weight than
    // state.ts's saveManifest() (no fsync, no cross-process lock, no
    // Windows rename-collision retry loop) -- this file holds one small,
    // low-stakes, short-lived credential, not the one record of what a
    // multi-hour job has already uploaded; losing it in the rare crash
    // window just means logging in again.
    const tmp = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    try {
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async loadRaw(): Promise<StoredToken | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      // Missing, unreadable, whatever -- there is no usable token.
      return null;
    }
    try {
      const parsed = JSON.parse(text) as Partial<StoredToken>;
      if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') return null;
      if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl === '') return null;
      const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined;
      return { accessToken: parsed.accessToken, baseUrl: parsed.baseUrl, expiresAt };
    } catch {
      // Corrupt/hand-edited file -- treat as absent rather than crash the
      // caller; the resulting "no token, log in again" error is the right
      // recovery either way.
      return null;
    }
  }

  async load(baseUrl: string): Promise<string | null> {
    const raw = await this.loadRaw();
    if (!raw) return null;
    if (raw.baseUrl !== baseUrl) return null;
    if (raw.expiresAt !== undefined && raw.expiresAt <= Date.now()) return null;
    return raw.accessToken;
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  clearSync(): void {
    try {
      unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
