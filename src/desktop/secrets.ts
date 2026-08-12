import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { unlinkSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoredToken, TokenStore } from '../core/tokenStore.js';
import { instanceKey, normaliseInstanceUrl } from '../core/instanceUrl.js';

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
 * The key one instance's credentials are stored under: `instanceKey` of its
 * address (core/instanceUrl.ts). A plain string, not a union of known names
 * -- the instances are the operator's own, added on Setup, and this tool
 * ships knowing none of them.
 */
export type InstanceId = string;

/** An openEQUELLA site the operator has added, as everything outside this module sees it. */
export interface Instance {
  id: InstanceId;
  /** What the operator calls it. Defaults to the address's host. */
  label: string;
  /** Normalised (`normaliseInstanceUrl`), so it can be concatenated with an api path. */
  baseUrl: string;
}

/**
 * On-disk shape for one instance's entry. Every field is required: an entry
 * missing one is not a usable credential, and filling the gap in would mean
 * inventing a value -- see `Settings.redirectUri` for what inventing that one
 * in particular has cost this project.
 */
type StoredEntry = Settings & { label: string; baseUrl: string };

/** On-disk shape written by THIS version of the store. */
interface StoredShapeV3 {
  version: 3;
  instances: Record<InstanceId, StoredEntry>;
}

/**
 * What `loadAll` returns: the store, plus whether readable credentials
 * written by an older version were found and thrown away. Setup needs that
 * second fact to explain an otherwise blank form -- see `credentialsDropped`.
 */
interface LoadResult {
  shape: StoredShapeV3;
  dropped: boolean;
}

function isStoredEntry(v: unknown): v is StoredEntry {
  const e = v as Partial<StoredEntry> | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.clientId === 'string' &&
    typeof e.clientSecret === 'string' &&
    typeof e.redirectUri === 'string' &&
    typeof e.label === 'string' &&
    typeof e.baseUrl === 'string'
  );
}

/**
 * Credentials are per instance: each openEQUELLA site registers its own OAuth
 * client, so a client ID that works on one is refused outright by another. A
 * site's entry is keyed by `instanceKey` of its address, which is what makes
 * two spellings of one address a single entry rather than two. Earlier
 * versions of this store persisted a single, unkeyed `{clientId,
 * clientSecret}` pair -- fine when the app only ever talked to one site,
 * wrong now that the operator can add any number of them.
 *
 * Migration: a store written by an older format cannot be rekeyed. `version:
 * 2` keyed entries by the literal names 'production' and 'test' -- two
 * addresses the app itself used to declare and no longer does -- and the
 * older flat format never recorded which site its pair belonged to at all.
 * Guessing would risk silently handing one site's client_id to another, which
 * is precisely the bug this store exists to prevent. So `loadAll` treats ANY
 * on-disk shape that isn't this version's `{version: 3, instances: {...}}`
 * wrapper -- v2, the old flat shape, a corrupt blob, or anything else
 * unrecognised -- as "no credentials saved at all". The operator sees Setup
 * again and re-enters what they have; that one-time re-prompt is a far
 * smaller cost than a wrong-instance credential being sent to openEQUELLA
 * unnoticed.
 *
 * A discard that happened silently would read as a broken app, so it is
 * reported: see `credentialsDropped`, and the notice Setup shows because of it.
 */
export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  /**
   * Add or update one instance and its credentials, returning the instance as
   * stored -- including the id, which is DERIVED here rather than supplied,
   * so there is exactly one rule for what an address's key is.
   *
   * A blank label falls back to the address's host: a dropdown of untitled
   * entries is no way to tell a live site from a sandbox, and the host is the
   * one name that is always available and always true.
   */
  async saveInstance(instance: { label: string; baseUrl: string }, settings: Settings): Promise<Instance> {
    if (!this.cipher.isAvailable()) {
      throw new Error(
        'OS encryption is unavailable, so credentials cannot be stored safely. ' +
          'Refusing to write them in plaintext.',
      );
    }
    // Before anything is written: an address that cannot be normalised has no
    // key, and https is required (see normaliseInstanceUrl).
    const baseUrl = normaliseInstanceUrl(instance.baseUrl);
    const id = instanceKey(baseUrl);
    const label = instance.label.trim() || new URL(baseUrl).host;

    const { shape } = await this.loadAll();
    shape.instances[id] = { label, baseUrl, ...settings };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, this.cipher.encrypt(JSON.stringify(shape)));
    return { id, label, baseUrl };
  }

  async loadSettings(instanceId: InstanceId): Promise<Settings | null> {
    const stored = (await this.loadAll()).shape.instances[instanceId];
    if (!stored) return null;
    return {
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      // Verbatim, never re-derived. See Settings.redirectUri.
      redirectUri: stored.redirectUri,
    };
  }

  /** The instance itself -- address and label -- without its credentials. */
  async loadInstance(instanceId: InstanceId): Promise<Instance | null> {
    const stored = (await this.loadAll()).shape.instances[instanceId];
    return stored ? { id: instanceId, label: stored.label, baseUrl: stored.baseUrl } : null;
  }

  /** Every instance the operator has added, for the dropdowns. Credentials stay here. */
  async listInstances(): Promise<Instance[]> {
    const { shape } = await this.loadAll();
    return Object.entries(shape.instances).map(([id, e]) => ({ id, label: e.label, baseUrl: e.baseUrl }));
  }

  async hasSettings(instanceId: InstanceId): Promise<boolean> {
    return (await this.loadSettings(instanceId)) !== null;
  }

  /**
   * Whether readable credentials written by an older version of this store
   * were found and discarded, so Setup can say so instead of presenting a
   * blank form that looks like a broken app.
   *
   * True only when a store was successfully decrypted and parsed and turned
   * out to be a shape this version does not accept. A blob that would not
   * decrypt at all is NOT reported: the notice claims something specific
   * happened to the operator's credentials, and an unreadable file is no
   * evidence of it.
   *
   * It reports the state of the file, so it stops being true the moment the
   * operator saves anything -- the old blob is overwritten by then and there
   * is nothing left to explain. That is what makes the notice appear once.
   */
  async credentialsDropped(): Promise<boolean> {
    return (await this.loadAll()).dropped;
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Reads and validates the on-disk store. Never throws -- see class doc. */
  private async loadAll(): Promise<LoadResult> {
    const empty = (dropped = false): LoadResult => ({ shape: { version: 3, instances: {} }, dropped });
    let blob: Buffer;
    try {
      blob = await readFile(this.filePath);
    } catch {
      // No file: a fresh install, with nothing to explain to anybody.
      return empty();
    }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(blob)) as Partial<StoredShapeV3>;
      if (parsed.version !== 3 || typeof parsed.instances !== 'object' || parsed.instances === null) {
        // A v2 store, the old single-pair format, or anything else
        // unrecognised. Discarded, and reported as discarded. See the
        // migration note in this class's doc comment.
        return empty(true);
      }
      const instances: Record<InstanceId, StoredEntry> = {};
      for (const [id, v] of Object.entries(parsed.instances as Record<string, unknown>)) {
        if (isStoredEntry(v)) instances[id] = v;
      }
      return { shape: { version: 3, instances }, dropped: false };
    } catch {
      // Corrupt, hand-edited, or written by a different OS user. Treat as
      // absent: the resulting "set up your credentials" prompt is the right
      // recovery either way. Not reported as a drop -- nothing was read.
      return empty();
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
