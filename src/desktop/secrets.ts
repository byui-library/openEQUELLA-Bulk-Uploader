import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { unlinkSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoredToken, TokenStore } from '../core/tokenStore.js';

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
}

export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  async saveSettings(settings: Settings): Promise<void> {
    if (!this.cipher.isAvailable()) {
      throw new Error(
        'OS encryption is unavailable, so credentials cannot be stored safely. ' +
          'Refusing to write them in plaintext.',
      );
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const blob = this.cipher.encrypt(JSON.stringify(settings));
    await writeFile(this.filePath, blob);
  }

  async loadSettings(): Promise<Settings | null> {
    let blob: Buffer;
    try {
      blob = await readFile(this.filePath);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(blob)) as Partial<Settings>;
      if (typeof parsed.clientId !== 'string' || typeof parsed.clientSecret !== 'string') {
        return null;
      }
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    } catch {
      // Corrupt, hand-edited, or written by a different OS user. Treat as
      // absent: the resulting "set up your credentials" prompt is the right
      // recovery either way.
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
