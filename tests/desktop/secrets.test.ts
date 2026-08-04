import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, EncryptedTokenStore, type Cipher } from '../../src/desktop/secrets.js';
import type { StoredToken } from '../../src/core/tokenStore.js';

// Stand-in for Electron's safeStorage. Reversible, not secure -- the point is
// to exercise SecretStore's logic without booting Electron.
//
// Deliberately NOT a prefix/suffix wrapper (e.g. `` `enc:${s}` ``): that would
// leave the plaintext bytes sitting unmodified in the file, so the "never
// writes the secret in plaintext" test below would fail even against a
// *correct* implementation that dutifully calls `cipher.encrypt` -- because
// the fake cipher itself doesn't hide anything. Base64-transcoding the bytes
// means the on-disk text genuinely does not contain the original substring,
// so that test actually exercises "did SecretStore call encrypt() before
// writing" rather than failing (or vacuously passing) regardless of whether
// it did.
const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decrypt: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8'),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-secrets-'));
});

describe('SecretStore', () => {
  it('round-trips settings', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveSettings({ clientId: 'cid', clientSecret: 'shhh' });
    const got = await s.loadSettings();
    expect(got).toEqual({ clientId: 'cid', clientSecret: 'shhh' });
  });

  it('returns null when nothing is stored', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    expect(await s.loadSettings()).toBeNull();
  });

  it('never writes the secret in plaintext', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.saveSettings({ clientId: 'cid', clientSecret: 'sup3rs3cret' });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('sup3rs3cret');
  });

  it('treats a corrupt blob as absent rather than throwing', async () => {
    const path = join(dir, 'settings.enc');
    await writeFile(path, 'not-valid', 'utf8');
    const s = new SecretStore(path, {
      ...fakeCipher,
      decrypt: () => {
        throw new Error('bad blob');
      },
    });
    expect(await s.loadSettings()).toBeNull();
  });

  it('clear() removes everything', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveSettings({ clientId: 'cid', clientSecret: 'x' });
    await s.clear();
    expect(await s.loadSettings()).toBeNull();
  });

  it('refuses to save when encryption is unavailable', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), { ...fakeCipher, isAvailable: () => false });
    await expect(s.saveSettings({ clientId: 'a', clientSecret: 'b' })).rejects.toThrow(/encryption/i);
  });
});

describe('EncryptedTokenStore', () => {
  const baseUrl = 'https://content-test.byui.edu';
  const otherBaseUrl = 'https://content.byui.edu';

  const token: StoredToken = { accessToken: 'tok-abc', baseUrl };

  it('round-trips a StoredToken', async () => {
    const t = new EncryptedTokenStore(join(dir, 'token.enc'), fakeCipher);
    await t.save(token);
    expect(await t.load(baseUrl)).toBe('tok-abc');
    expect(await t.loadRaw()).toEqual(token);
  });

  it('refuses a token issued for a different baseUrl', async () => {
    const t = new EncryptedTokenStore(join(dir, 'token.enc'), fakeCipher);
    await t.save(token);
    expect(await t.load(otherBaseUrl)).toBeNull();
    // loadRaw() is deliberately unvalidated -- baseUrl checking is load()'s job.
    expect(await t.loadRaw()).toEqual(token);
  });

  it('treats an expired token as absent', async () => {
    const t = new EncryptedTokenStore(join(dir, 'token.enc'), fakeCipher);
    await t.save({ ...token, expiresAt: Date.now() - 1000 });
    expect(await t.load(baseUrl)).toBeNull();
  });

  it('treats a corrupt blob as absent rather than throwing', async () => {
    const path = join(dir, 'token.enc');
    await writeFile(path, 'not-valid', 'utf8');
    const t = new EncryptedTokenStore(path, {
      ...fakeCipher,
      decrypt: () => {
        throw new Error('bad blob');
      },
    });
    expect(await t.load(baseUrl)).toBeNull();
    expect(await t.loadRaw()).toBeNull();
  });

  it('clearSync() removes it, and a fresh store pointed at the same path sees nothing', async () => {
    const path = join(dir, 'token.enc');
    const t = new EncryptedTokenStore(path, fakeCipher);
    await t.save(token);
    t.clearSync();

    const t2 = new EncryptedTokenStore(path, fakeCipher);
    expect(await t2.load(baseUrl)).toBeNull();
    expect(await t2.loadRaw()).toBeNull();
  });

  it('refuses to save when encryption is unavailable', async () => {
    const t = new EncryptedTokenStore(join(dir, 'token.enc'), { ...fakeCipher, isAvailable: () => false });
    await expect(t.save(token)).rejects.toThrow(/encryption/i);
  });

  it('never writes the access token in plaintext', async () => {
    const path = join(dir, 'token.enc');
    const t = new EncryptedTokenStore(path, fakeCipher);
    await t.save({ accessToken: 'sup3rs3cretToken', baseUrl });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('sup3rs3cretToken');
  });
});
