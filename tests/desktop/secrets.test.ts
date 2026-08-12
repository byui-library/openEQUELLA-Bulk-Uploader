import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, EncryptedTokenStore, type Cipher } from '../../src/desktop/secrets.js';
import { instanceKey } from '../../src/core/instanceUrl.js';
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

// Two sites the operator added themselves. Nothing ships knowing either one.
const LIVE = 'https://oeq.example.edu';
const SANDBOX = 'https://oeq-test.example.edu';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-secrets-'));
});

describe('SecretStore', () => {
  it('round-trips settings for one instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    const inst = await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE },
    );
    expect(await s.loadSettings(inst.id)).toEqual({
      clientId: 'cid',
      clientSecret: 'shhh',
      redirectUri: LIVE,
    });
  });

  // The entry is keyed by the NORMALISED address, so an operator who types
  // the same site with a trailing slash on Tuesday edits Monday's entry
  // instead of creating a second one that then drifts from it.
  it('keys an instance by its normalised address, so two spellings are one entry', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    const first = await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE },
    );
    const second = await s.saveInstance(
      { label: 'Live', baseUrl: `${LIVE}/` },
      { clientId: 'cid-2', clientSecret: 'shhh-2', redirectUri: LIVE },
    );

    expect(second.id).toBe(first.id);
    expect(second.id).toBe(instanceKey(LIVE));
    expect(second.baseUrl).toBe(LIVE);
    expect(await s.listInstances()).toHaveLength(1);
    expect((await s.loadSettings(instanceKey(`${LIVE}/`)))?.clientId).toBe('cid-2');
  });

  it('labels an instance with its host when the operator names it nothing', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    const inst = await s.saveInstance(
      { label: '   ', baseUrl: LIVE },
      { clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE },
    );
    expect(inst.label).toBe('oeq.example.edu');
    expect((await s.listInstances())[0]?.label).toBe('oeq.example.edu');
  });

  // The redirect URI is registered per OAuth client by an administrator and
  // is NOT derivable from the base url -- one client has a trailing slash,
  // another does not. This exact value has been guessed wrong twice in this
  // project, so the store must round-trip whatever string was saved,
  // verbatim, including the presence or absence of that slash.
  it('round-trips a redirectUri WITH a trailing slash and one WITHOUT, verbatim', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'live-id', clientSecret: 'live-secret', redirectUri: LIVE },
    );
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { clientId: 'sandbox-id', clientSecret: 'sandbox-secret', redirectUri: `${SANDBOX}/` },
    );

    expect((await s.loadSettings(instanceKey(LIVE)))?.redirectUri).toBe(LIVE);
    expect((await s.loadSettings(instanceKey(SANDBOX)))?.redirectUri).toBe(`${SANDBOX}/`);
  });

  it('returns null when nothing is stored for that instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    expect(await s.loadSettings(instanceKey(LIVE))).toBeNull();
    expect(await s.loadInstance(instanceKey(LIVE))).toBeNull();
    expect(await s.listInstances()).toEqual([]);
  });

  // The bug the per-instance store exists to fix: two sites use different
  // OAuth clients, so saving one instance's credentials must never clobber
  // or leak into the other's.
  it('saving one instance leaves the other intact', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'live-id', clientSecret: 'live-secret', redirectUri: LIVE },
    );
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { clientId: 'sandbox-id', clientSecret: 'sandbox-secret', redirectUri: `${SANDBOX}/` },
    );

    // Re-saving one must not disturb the other's entry.
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'live-id-2', clientSecret: 'live-secret-2', redirectUri: LIVE },
    );
    expect(await s.loadSettings(instanceKey(LIVE))).toEqual({
      clientId: 'live-id-2',
      clientSecret: 'live-secret-2',
      redirectUri: LIVE,
    });
    expect(await s.loadSettings(instanceKey(SANDBOX))).toEqual({
      clientId: 'sandbox-id',
      clientSecret: 'sandbox-secret',
      redirectUri: `${SANDBOX}/`,
    });
    expect((await s.listInstances()).map((i) => i.baseUrl).sort()).toEqual([SANDBOX, LIVE].sort());
  });

  it('hasSettings reflects only the requested instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    expect(await s.hasSettings(instanceKey(LIVE))).toBe(false);
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'cid', clientSecret: 'x', redirectUri: LIVE },
    );
    expect(await s.hasSettings(instanceKey(LIVE))).toBe(true);
    expect(await s.hasSettings(instanceKey(SANDBOX))).toBe(false);
  });

  it('never writes either instance secret in plaintext', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'cid', clientSecret: 'sup3rs3cretLive', redirectUri: LIVE },
    );
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { clientId: 'cid2', clientSecret: 'sup3rs3cretSandbox', redirectUri: SANDBOX },
    );
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('sup3rs3cretLive');
    expect(raw).not.toContain('sup3rs3cretSandbox');
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
    expect(await s.loadSettings(instanceKey(LIVE))).toBeNull();
    expect(await s.listInstances()).toEqual([]);
    // Nothing was ever read, so nothing can honestly be reported as dropped.
    // Setup's notice claims a specific thing happened to the operator's
    // credentials; a blob we could not decrypt is not evidence of it.
    expect(await s.credentialsDropped()).toBe(false);
  });

  /**
   * The clean break, settled 2026-08-12. `version: 2` keyed credentials by
   * the literal names 'production' and 'test' -- BYU-Idaho's two instances,
   * hardcoded in the shipped app. Instances are now the operator's own, keyed
   * by address, so there is no honest way to say which site a v2 entry
   * belonged to. Guessing would send one site's client_id to another, which
   * is the failure this store has always refused to risk.
   */
  it('discards a version 2 store outright rather than rekeying it', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({
          version: 2,
          instances: {
            production: { clientId: 'prod-id', clientSecret: 'prod-secret', redirectUri: LIVE },
            test: { clientId: 'test-id', clientSecret: 'test-secret', redirectUri: SANDBOX },
          },
        }),
      ),
    );

    expect(await s.listInstances()).toEqual([]);
    expect(await s.loadSettings('production')).toBeNull();
    expect(await s.loadSettings('test')).toBeNull();
    expect(await s.loadSettings(instanceKey(LIVE))).toBeNull();
  });

  /**
   * Discarding silently would leave the operator staring at an empty Setup
   * form that reads as a broken app. The store has to be able to say that it
   * found credentials and dropped them -- that sentence is the whole cost of
   * the clean break.
   */
  it('reports that a version 2 store was found and dropped', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({
          version: 2,
          instances: { production: { clientId: 'prod-id', clientSecret: 'prod-secret' } },
        }),
      ),
    );
    expect(await s.credentialsDropped()).toBe(true);
  });

  it('reports nothing dropped on a fresh install, which has nothing to explain', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    expect(await s.credentialsDropped()).toBe(false);
  });

  it('stops reporting a drop once the operator has saved credentials again', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({ version: 2, instances: { production: { clientId: 'a', clientSecret: 'b' } } }),
      ),
    );
    expect(await s.credentialsDropped()).toBe(true);

    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE },
    );
    // The v2 blob is gone from disk now, so the notice has nothing left to
    // explain and must not follow the operator around.
    expect(await s.credentialsDropped()).toBe(false);
  });

  // The oldest format of all: a flat, unkeyed `{clientId, clientSecret}` pair
  // that never recorded which site it belonged to. Same call as for v2 --
  // treated as no credentials at all rather than guessed at.
  it('treats an old single-pair store as no credentials, and says it dropped them', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await writeFile(path, fakeCipher.encrypt(JSON.stringify({ clientId: 'old-id', clientSecret: 'old-secret' })));

    expect(await s.listInstances()).toEqual([]);
    expect(await s.credentialsDropped()).toBe(true);

    // And saving an instance afterwards must not resurrect the old pair.
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'new-id', clientSecret: 'new-secret', redirectUri: LIVE },
    );
    expect(await s.loadSettings(instanceKey(LIVE))).toEqual({
      clientId: 'new-id',
      clientSecret: 'new-secret',
      redirectUri: LIVE,
    });
    expect(await s.listInstances()).toHaveLength(1);
  });

  // A hand-edited or half-written entry is not a usable credential. Filling
  // the gap in would mean inventing a redirect_uri, and an invented one
  // reaches openEQUELLA as a mismatch the operator cannot diagnose.
  it('ignores an entry missing any required field rather than filling it in', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({
          version: 3,
          instances: {
            [instanceKey(LIVE)]: { label: 'Live', baseUrl: LIVE, clientId: 'cid', clientSecret: 'x' },
            [instanceKey(SANDBOX)]: {
              label: 'Sandbox',
              baseUrl: SANDBOX,
              clientId: 'cid2',
              clientSecret: 'y',
              redirectUri: SANDBOX,
            },
          },
        }),
      ),
    );
    expect(await s.loadSettings(instanceKey(LIVE))).toBeNull();
    expect(await s.loadSettings(instanceKey(SANDBOX))).not.toBeNull();
  });

  it('clear() wipes every instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { clientId: 'cid', clientSecret: 'x', redirectUri: LIVE },
    );
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { clientId: 'cid2', clientSecret: 'y', redirectUri: SANDBOX },
    );
    await s.clear();
    expect(await s.listInstances()).toEqual([]);
    expect(await s.loadSettings(instanceKey(LIVE))).toBeNull();
    expect(await s.loadSettings(instanceKey(SANDBOX))).toBeNull();
  });

  it('refuses to save when encryption is unavailable', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), { ...fakeCipher, isAvailable: () => false });
    await expect(
      s.saveInstance({ label: 'Live', baseUrl: LIVE }, { clientId: 'a', clientSecret: 'b', redirectUri: LIVE }),
    ).rejects.toThrow(/encryption/i);
  });

  it('refuses an address that is not a usable openEQUELLA site', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await expect(
      s.saveInstance(
        { label: 'Live', baseUrl: 'http://oeq.example.edu' },
        { clientId: 'a', clientSecret: 'b', redirectUri: 'http://oeq.example.edu' },
      ),
    ).rejects.toThrow(/https/i);
  });
});

describe('EncryptedTokenStore', () => {
  const baseUrl = SANDBOX;
  const otherBaseUrl = LIVE;

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
