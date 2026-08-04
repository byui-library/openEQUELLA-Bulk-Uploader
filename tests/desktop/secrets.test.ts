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
  it('round-trips settings for one instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveSettings('production', { clientId: 'cid', clientSecret: 'shhh' });
    const got = await s.loadSettings('production');
    expect(got).toEqual({ clientId: 'cid', clientSecret: 'shhh' });
  });

  it('returns null when nothing is stored for that instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    expect(await s.loadSettings('production')).toBeNull();
    expect(await s.loadSettings('test')).toBeNull();
  });

  // The bug this whole change fixes: production and test use different OAuth
  // clients, so saving one instance's credentials must never clobber or leak
  // into the other's.
  it('saving one instance leaves the other intact', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveSettings('production', { clientId: 'prod-id', clientSecret: 'prod-secret' });
    await s.saveSettings('test', { clientId: 'test-id', clientSecret: 'test-secret' });

    expect(await s.loadSettings('production')).toEqual({ clientId: 'prod-id', clientSecret: 'prod-secret' });
    expect(await s.loadSettings('test')).toEqual({ clientId: 'test-id', clientSecret: 'test-secret' });

    // Re-saving production must not disturb test's entry.
    await s.saveSettings('production', { clientId: 'prod-id-2', clientSecret: 'prod-secret-2' });
    expect(await s.loadSettings('production')).toEqual({ clientId: 'prod-id-2', clientSecret: 'prod-secret-2' });
    expect(await s.loadSettings('test')).toEqual({ clientId: 'test-id', clientSecret: 'test-secret' });
  });

  it('hasSettings reflects only the requested instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    expect(await s.hasSettings('production')).toBe(false);
    await s.saveSettings('production', { clientId: 'cid', clientSecret: 'x' });
    expect(await s.hasSettings('production')).toBe(true);
    expect(await s.hasSettings('test')).toBe(false);
  });

  it('never writes either instance secret in plaintext', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.saveSettings('production', { clientId: 'cid', clientSecret: 'sup3rs3cretProd' });
    await s.saveSettings('test', { clientId: 'cid2', clientSecret: 'sup3rs3cretTest' });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('sup3rs3cretProd');
    expect(raw).not.toContain('sup3rs3cretTest');
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
    expect(await s.loadSettings('production')).toBeNull();
    expect(await s.loadSettings('test')).toBeNull();
  });

  // Migration decision: a store written by the old single-pair format (a
  // flat `{clientId, clientSecret}` object, with no `version`/`instances`
  // wrapper) is indistinguishable from "which instance was this for?" -- the
  // old format never recorded that. Guessing wrong would silently send one
  // instance's client_id to the other, which is exactly the bug this change
  // fixes. So an unrecognised shape (old format OR anything else we don't
  // understand) is treated as "no credentials saved for either instance" --
  // the operator re-enters them once, which is a minor inconvenience, never
  // a silently wrong credential.
  it('treats an old-format (pre-migration) store as no credentials for either instance', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    // Write the OLD flat shape directly, bypassing the new saveSettings.
    const oldBlob = fakeCipher.encrypt(JSON.stringify({ clientId: 'old-id', clientSecret: 'old-secret' }));
    await writeFile(path, oldBlob);

    expect(await s.loadSettings('production')).toBeNull();
    expect(await s.loadSettings('test')).toBeNull();

    // And saving one instance afterwards must not resurrect the old pair
    // under the other instance.
    await s.saveSettings('production', { clientId: 'new-id', clientSecret: 'new-secret' });
    expect(await s.loadSettings('production')).toEqual({ clientId: 'new-id', clientSecret: 'new-secret' });
    expect(await s.loadSettings('test')).toBeNull();
  });

  it('clear() wipes both instances', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveSettings('production', { clientId: 'cid', clientSecret: 'x' });
    await s.saveSettings('test', { clientId: 'cid2', clientSecret: 'y' });
    await s.clear();
    expect(await s.loadSettings('production')).toBeNull();
    expect(await s.loadSettings('test')).toBeNull();
  });

  it('refuses to save when encryption is unavailable', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), { ...fakeCipher, isAvailable: () => false });
    await expect(s.saveSettings('production', { clientId: 'a', clientSecret: 'b' })).rejects.toThrow(/encryption/i);
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
