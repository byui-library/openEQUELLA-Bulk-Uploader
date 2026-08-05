import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { unlinkSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoredToken, TokenStore } from '../core/tokenStore.js';
import { INSTANCES } from './ipc.js';

/**
 * The subset of Electron's `safeStorage` this module needs, extracted as an
 * interface so tests can substitute a fake. On Windows the real
 * implementation encrypts via DPAPI -- the same OS mechanism that backs
 * Credential Manager -- scoped to the logged-in user.
 */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export interface Settings {
  clientId: string;
  clientSecret: string;
  /**
   * Registered on the OAuth client by an administrator and NOT derivable
   * from the instance's base url -- production has no trailing slash, one
   * test client had one, another dedicated test client does not. This exact
   * value has been guessed wrong TWICE in this project by hard-coding it
   * (see ipc.ts's INSTANCES doc comment), so it is now stored configuration,
   * collected in Setup and sent to openEQUELLA verbatim, never re-derived.
   */
  redirectUri: string;
}

/**
 * The OAuth client on production is a completely different registration
 * from the one on test -- see the module doc below -- so credentials are
 * keyed by instance, never shared.
 */
export type InstanceId = 'production' | 'test';

const INSTANCE_IDS: readonly InstanceId[] = ['production', 'test'];

/**
 * On-disk shape for one instance's entry. `redirectUri` is OPTIONAL here,
 * even though it is required on the public `Settings` type `loadSettings`
 * returns: entries written by this project's very first per-instance store
 * (commit f31505b, before this field existed) have no `redirectUri` key at
 * all. See `defaultRedirectUri` and the migration note on `loadSettings`
 * below for how that gap is filled back in.
 */
type StoredSettings = Pick<Settings, 'clientId' | 'clientSecret'> & Partial<Pick<Settings, 'redirectUri'>>;

/** On-disk shape written by THIS version of the store. */
interface StoredShapeV2 {
  version: 2;
  instances: Partial<Record<InstanceId, StoredSettings>>;
}

function isStoredSettings(v: unknown): v is StoredSettings {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Partial<StoredSettings>).clientId === 'string' &&
    typeof (v as Partial<StoredSettings>).clientSecret === 'string' &&
    ((v as Partial<StoredSettings>).redirectUri === undefined ||
      typeof (v as Partial<StoredSettings>).redirectUri === 'string')
  );
}

/**
 * Migration default for a stored entry that predates `redirectUri` (and the
 * sensible pre-fill Setup shows for a fresh entry): the instance's own base
 * url, with no trailing slash -- verified live to match both of the
 * operator's new dedicated OAuth clients. Forcing re-entry instead would
 * have been the THIRD time in one day the operator had to retype
 * credentials for a gap that has nothing to do with the client ID/secret
 * they already typed correctly.
 */
function defaultRedirectUri(instanceId: InstanceId): string {
  const inst = INSTANCES.find((i) => i.id === instanceId);
  // INSTANCES always declares both known instance ids (guarded by
  // session.test.ts); this fallback only matters if that invariant is ever
  // violated.
  return inst ? inst.baseUrl.replace(/\/+$/, '') : '';
}

/**
 * Credentials are per instance: production (`content.byui.edu`) and test
 * (`content-test.byui.edu`) each register their own OAuth client, so a
 * client ID that works on one is refused outright by the other. Earlier
 * versions of this store persisted a single, unkeyed `{clientId,
 * clientSecret}` pair -- fine when the app only ever talked to one
 * instance, wrong now that it can talk to either.
 *
 * Migration: a store written by that old format is indistinguishable from
 * "which instance was this pair for?" -- the old format never recorded
 * that, and guessing would risk silently handing one instance's client_id
 * to the other, which is precisely the bug being fixed here. So `loadAll`
 * treats ANY on-disk shape that isn't this version's `{version: 2,
 * instances: {...}}` wrapper -- the old flat shape, a corrupt blob, or
 * anything else unrecognised -- as "no credentials saved for either
 * instance". The operator sees Setup again and re-enters what they have;
 * that one-time re-prompt is a far smaller cost than a wrong-instance
 * credential being sent to openEQUELLA unnoticed.
 */
export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  async saveSettings(instanceId: InstanceId, settings: Settings): Promise<void> {
    if (!this.cipher.isAvailable()) {
      throw new Error(
        'OS encryption is unavailable, so credentials cannot be stored safely. ' +
          'Refusing to write them in plaintext.',
      );
    }
    const current = await this.loadAll();
    current.instances[instanceId] = settings;
    await mkdir(dirname(this.filePath), { recursive: true });
    const blob = this.cipher.encrypt(JSON.stringify(current));
    await writeFile(this.filePath, blob);
  }

  /**
   * Migration: an entry saved before `redirectUri` existed has no such key
   * on disk (see `StoredSettings`'s doc comment). Rather than surface that
   * gap as `undefined` -- which would go straight into an OAuth
   * authorize-url query string as the literal string `"undefined"` -- it is
   * filled in here with `defaultRedirectUri`, once, on every read. Nothing
   * is written back to disk by this; the fill-in is applied fresh each time
   * until the operator (or Setup's own pre-filled default) actually saves a
   * value for it.
   */
  async loadSettings(instanceId: InstanceId): Promise<Settings | null> {
    const all = await this.loadAll();
    const stored = all.instances[instanceId];
    if (!stored) return null;
    return {
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      redirectUri: stored.redirectUri ?? defaultRedirectUri(instanceId),
    };
  }

  async hasSettings(instanceId: InstanceId): Promise<boolean> {
    return (await this.loadSettings(instanceId)) !== null;
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Reads and validates the on-disk store. Never throws -- see class doc. */
  private async loadAll(): Promise<StoredShapeV2> {
    const empty: StoredShapeV2 = { version: 2, instances: {} };
    let blob: Buffer;
    try {
      blob = await readFile(this.filePath);
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(blob)) as Partial<StoredShapeV2>;
      if (parsed.version !== 2 || typeof parsed.instances !== 'object' || parsed.instances === null) {
        // Old single-pair format, or anything else unrecognised. See the
        // migration note in this class's doc comment.
        return empty;
      }
      const instances: Partial<Record<InstanceId, StoredSettings>> = {};
      for (const id of INSTANCE_IDS) {
        const v = (parsed.instances as Partial<Record<InstanceId, unknown>>)[id];
        if (isStoredSettings(v)) instances[id] = v;
      }
      return { version: 2, instances };
    } catch {
      // Corrupt, hand-edited, or written by a different OS user. Treat as
      // absent: the resulting "set up your credentials" prompt is the right
      // recovery either way.
      return empty;
    }
  }
}

/**
 * `TokenStore` backed by OS encryption instead of a plaintext JSON file.
 *
 * `clearSync` exists because `AuthProvider.invalidate()` is synchronous and
 * `client.ts` retries in the same tick -- an async clear would race that
 * retry. See the note in core/tokenStore.ts.
 */
export class EncryptedTokenStore implements TokenStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  async save(data: StoredToken): Promise<void> {
    if (!this.cipher.isAvailable()) throw new Error('OS encryption unavailable; refusing to store a token.');
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, this.cipher.encrypt(JSON.stringify(data)));
  }

  async loadRaw(): Promise<StoredToken | null> {
    let blob: Buffer;
    try {
      blob = readFileSync(this.filePath);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(blob)) as Partial<StoredToken>;
      if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') return null;
      if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl === '') return null;
      return {
        accessToken: parsed.accessToken,
        baseUrl: parsed.baseUrl,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
      };
    } catch {
      // Corrupt, hand-edited, or written by a different OS user. Treat as
      // absent -- see core/tokenStore.ts for why this is the right recovery.
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
    this.clearSync();
  }

  clearSync(): void {
    try {
      unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
