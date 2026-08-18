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
      { authMode: 'code', clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE },
    );
    expect(await s.loadSettings(inst.id)).toEqual({
      authMode: 'code',
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
      { authMode: 'code', clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE },
    );
    const second = await s.saveInstance(
      { label: 'Live', baseUrl: `${LIVE}/` },
      { authMode: 'code', clientId: 'cid-2', clientSecret: 'shhh-2', redirectUri: LIVE },
    );

    expect(second.id).toBe(first.id);
    expect(second.id).toBe(instanceKey(LIVE));
    expect(second.baseUrl).toBe(LIVE);
    expect(await s.listInstances()).toHaveLength(1);
    expect(await s.loadSettings(instanceKey(`${LIVE}/`))).toMatchObject({ clientId: 'cid-2' });
  });

  it('labels an instance with its host when the operator names it nothing', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    const inst = await s.saveInstance(
      { label: '   ', baseUrl: LIVE },
      { authMode: 'code', clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE },
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
      { authMode: 'code', clientId: 'live-id', clientSecret: 'live-secret', redirectUri: LIVE },
    );
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { authMode: 'code', clientId: 'sandbox-id', clientSecret: 'sandbox-secret', redirectUri: `${SANDBOX}/` },
    );

    expect(await s.loadSettings(instanceKey(LIVE))).toMatchObject({ redirectUri: LIVE });
    expect(await s.loadSettings(instanceKey(SANDBOX))).toMatchObject({ redirectUri: `${SANDBOX}/` });
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
      { authMode: 'code', clientId: 'live-id', clientSecret: 'live-secret', redirectUri: LIVE },
    );
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { authMode: 'code', clientId: 'sandbox-id', clientSecret: 'sandbox-secret', redirectUri: `${SANDBOX}/` },
    );

    // Re-saving one must not disturb the other's entry.
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { authMode: 'code', clientId: 'live-id-2', clientSecret: 'live-secret-2', redirectUri: LIVE },
    );
    expect(await s.loadSettings(instanceKey(LIVE))).toEqual({
      authMode: 'code',
      clientId: 'live-id-2',
      clientSecret: 'live-secret-2',
      redirectUri: LIVE,
    });
    expect(await s.loadSettings(instanceKey(SANDBOX))).toEqual({
      authMode: 'code',
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
      { authMode: 'code', clientId: 'cid', clientSecret: 'x', redirectUri: LIVE },
    );
    expect(await s.hasSettings(instanceKey(LIVE))).toBe(true);
    expect(await s.hasSettings(instanceKey(SANDBOX))).toBe(false);
  });

  it('never writes either instance secret in plaintext', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { authMode: 'code', clientId: 'cid', clientSecret: 'sup3rs3cretLive', redirectUri: LIVE },
    );
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { authMode: 'code', clientId: 'cid2', clientSecret: 'sup3rs3cretSandbox', redirectUri: SANDBOX },
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
      { authMode: 'code', clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE },
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
      { authMode: 'code', clientId: 'new-id', clientSecret: 'new-secret', redirectUri: LIVE },
    );
    expect(await s.loadSettings(instanceKey(LIVE))).toEqual({
      authMode: 'code',
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
      { authMode: 'code', clientId: 'cid', clientSecret: 'x', redirectUri: LIVE },
    );
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { authMode: 'code', clientId: 'cid2', clientSecret: 'y', redirectUri: SANDBOX },
    );
    await s.clear();
    expect(await s.listInstances()).toEqual([]);
    expect(await s.loadSettings(instanceKey(LIVE))).toBeNull();
    expect(await s.loadSettings(instanceKey(SANDBOX))).toBeNull();
  });

  it('refuses to save when encryption is unavailable', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), { ...fakeCipher, isAvailable: () => false });
    await expect(
      s.saveInstance(
        { label: 'Live', baseUrl: LIVE },
        { authMode: 'code', clientId: 'a', clientSecret: 'b', redirectUri: LIVE },
      ),
    ).rejects.toThrow(/encryption/i);
  });

  it('refuses an address that is not a usable openEQUELLA site', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await expect(
      s.saveInstance(
        { label: 'Live', baseUrl: 'http://oeq.example.edu' },
        { authMode: 'code', clientId: 'a', clientSecret: 'b', redirectUri: 'http://oeq.example.edu' },
      ),
    ).rejects.toThrow(/https/i);
  });
});

/**
 * The password half. An institution that is not behind SSO signs in with an
 * ordinary openEQUELLA account, so the store has to hold one -- under exactly
 * the same OS encryption and the same per-instance keying as the client
 * secret, because the failure it prevents is the same one: one site's
 * credential must never be handed to another.
 */
describe('SecretStore passwords', () => {
  it('round-trips a username and password for one instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.setPassword(instanceKey(LIVE), 'm.rowan', 'hunter2');
    expect(await s.getPassword(instanceKey(LIVE))).toEqual({ username: 'm.rowan', password: 'hunter2' });
  });

  it('keeps two instances apart rather than letting one overwrite the other', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.setPassword(instanceKey(LIVE), 'live-user', 'live-pass');
    await s.setPassword(instanceKey(SANDBOX), 'sandbox-user', 'sandbox-pass');

    expect(await s.getPassword(instanceKey(LIVE))).toEqual({ username: 'live-user', password: 'live-pass' });
    expect(await s.getPassword(instanceKey(SANDBOX))).toEqual({
      username: 'sandbox-user',
      password: 'sandbox-pass',
    });
  });

  it('keys a password by the normalised address, like every other credential', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.setPassword(instanceKey(`${LIVE}/`), 'm.rowan', 'hunter2');
    expect((await s.getPassword(instanceKey(LIVE)))?.username).toBe('m.rowan');
  });

  it('replaces a stored password rather than accumulating them', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.setPassword(instanceKey(LIVE), 'm.rowan', 'old');
    await s.setPassword(instanceKey(LIVE), 'm.rowan', 'new');
    expect(await s.getPassword(instanceKey(LIVE))).toEqual({ username: 'm.rowan', password: 'new' });
  });

  // Behind the Forget button.
  it('forgetPassword leaves nothing behind, for that instance only', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.setPassword(instanceKey(LIVE), 'm.rowan', 'sup3rs3cretPassword');
    await s.setPassword(instanceKey(SANDBOX), 'other', 'other-pass');

    await s.forgetPassword(instanceKey(LIVE));

    expect(await s.getPassword(instanceKey(LIVE))).toBeNull();
    expect(await s.getPassword(instanceKey(SANDBOX))).toEqual({ username: 'other', password: 'other-pass' });
    // Not merely hidden from getPassword: gone from the file.
    const raw = fakeCipher.decrypt(await readFile(path));
    expect(raw).not.toContain('m.rowan');
  });

  it('forgetting a password that was never stored is not an error', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await expect(s.forgetPassword(instanceKey(LIVE))).resolves.toBeUndefined();
  });

  it('returns null when no password is stored for that instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.setPassword(instanceKey(LIVE), 'm.rowan', 'hunter2');
    expect(await s.getPassword(instanceKey(SANDBOX))).toBeNull();
  });

  // Same recovery as every other read here: an unreadable store is treated as
  // absent, never as an exception the UI has to catch on a screen whose whole
  // job is to say "sign in".
  it('returns null, and does not throw, on a corrupt store', async () => {
    const path = join(dir, 'settings.enc');
    await writeFile(path, 'not-valid', 'utf8');
    const s = new SecretStore(path, {
      ...fakeCipher,
      decrypt: () => {
        throw new Error('bad blob');
      },
    });
    await expect(s.getPassword(instanceKey(LIVE))).resolves.toBeNull();
  });

  it('never writes the password in plaintext', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.setPassword(instanceKey(LIVE), 'm.rowan', 'sup3rs3cretPassword');
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('sup3rs3cretPassword');
  });

  // The store refuses to write a client secret in plaintext; a password is no
  // different, and an OS with no working encryption must not be quietly
  // downgraded to a text file holding somebody's account password.
  it('refuses to store a password when encryption is unavailable', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), { ...fakeCipher, isAvailable: () => false });
    await expect(s.setPassword(instanceKey(LIVE), 'm.rowan', 'hunter2')).rejects.toThrow(/encryption/i);
  });

  it('round-trips a password-mode instance through saveInstance and loadSettings', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    const inst = await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { authMode: 'password', username: 'm.rowan', password: 'hunter2' },
    );
    expect(await s.loadSettings(inst.id)).toEqual({
      authMode: 'password',
      username: 'm.rowan',
      password: 'hunter2',
    });
    expect(await s.getPassword(inst.id)).toEqual({ username: 'm.rowan', password: 'hunter2' });
  });

  /**
   * Setup never renders a stored password back into a field, so the form it
   * submits when the operator only renamed the site carries an empty one.
   * Treating that as "the password is now empty" would silently sign them out
   * of a site they never touched; the only way to remove a password is the
   * Forget button.
   */
  it('saving with a blank password leaves the stored one alone', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { authMode: 'password', username: 'm.rowan', password: 'hunter2' },
    );
    await s.saveInstance(
      { label: 'Renamed', baseUrl: LIVE },
      { authMode: 'password', username: 'm.rowan', password: '' },
    );
    expect(await s.getPassword(instanceKey(LIVE))).toEqual({ username: 'm.rowan', password: 'hunter2' });
    expect((await s.loadInstance(instanceKey(LIVE)))?.label).toBe('Renamed');
  });

  // A password-mode instance whose password has been forgotten has no usable
  // credential, and must be reported as such rather than as a sign-in that
  // will fail with an empty password.
  it('reports a password-mode instance with no stored password as having no settings', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance(
      { label: 'Live', baseUrl: LIVE },
      { authMode: 'password', username: 'm.rowan', password: 'hunter2' },
    );
    await s.forgetPassword(instanceKey(LIVE));
    expect(await s.loadSettings(instanceKey(LIVE))).toBeNull();
    expect(await s.hasSettings(instanceKey(LIVE))).toBe(false);
    // The site itself is still there -- only the credential went.
    expect(await s.loadInstance(instanceKey(LIVE))).not.toBeNull();
  });

  /**
   * Version 3 entries were written by this same branch, days -- in places
   * minutes -- before password auth existed, and every one of them is an OAuth
   * entry. Discarding them over a field that had not been invented yet would
   * send an operator back to their administrator for a client secret for no
   * reason at all, so a missing `authMode` reads as 'code'.
   */
  it('loads a version 3 entry written before authMode existed, as code', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({
          version: 3,
          instances: {
            [instanceKey(LIVE)]: {
              label: 'Live',
              baseUrl: LIVE,
              clientId: 'cid',
              clientSecret: 'shhh',
              redirectUri: `${LIVE}/`,
            },
          },
        }),
      ),
    );

    expect(await s.loadSettings(instanceKey(LIVE))).toEqual({
      authMode: 'code',
      clientId: 'cid',
      clientSecret: 'shhh',
      redirectUri: `${LIVE}/`,
    });
    expect(await s.listInstances()).toHaveLength(1);
    expect(await s.credentialsDropped()).toBe(false);
  });

  // A password entry legitimately has no client id, so the OAuth fields must
  // not be demanded of it -- but they are still demanded of a code entry.
  it('keeps a password entry that has no OAuth fields at all', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({
          version: 3,
          instances: { [instanceKey(LIVE)]: { label: 'Live', baseUrl: LIVE, authMode: 'password' } },
          passwords: { [instanceKey(LIVE)]: { username: 'm.rowan', password: 'hunter2' } },
        }),
      ),
    );

    expect(await s.loadSettings(instanceKey(LIVE))).toEqual({
      authMode: 'password',
      username: 'm.rowan',
      password: 'hunter2',
    });
  });

  it('clear() takes the passwords with it', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.setPassword(instanceKey(LIVE), 'm.rowan', 'hunter2');
    await s.clear();
    expect(await s.getPassword(instanceKey(LIVE))).toBeNull();
  });
});

/**
 * The per-site settings, which are facts about the SITE rather than about the
 * credential -- true whether it is reached with a password or an OAuth client
 * -- and so live on the instance entry rather than inside `Settings`.
 */
describe('SecretStore — per-site settings', () => {
  const CODE = { authMode: 'code', clientId: 'cid', clientSecret: 'shhh', redirectUri: LIVE } as const;
  const PATH = 'BYUI_extended/attachments/attachment';

  it('round-trips the attachment path for one instance', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    const inst = await s.saveInstance({ label: 'Live', baseUrl: LIVE, attachmentUuidPath: PATH }, CODE);
    expect(inst.attachmentUuidPath).toBe(PATH);
    expect((await s.loadInstance(instanceKey(LIVE)))?.attachmentUuidPath).toBe(PATH);
    expect((await s.listInstances())[0]?.attachmentUuidPath).toBe(PATH);
  });

  // Per SITE, not per machine -- which is precisely what the environment
  // variable it replaced could never be.
  it('keeps a different attachment path for each site', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance({ label: 'Live', baseUrl: LIVE, attachmentUuidPath: PATH }, CODE);
    await s.saveInstance({ label: 'Sandbox', baseUrl: SANDBOX, attachmentUuidPath: '' }, { ...CODE, redirectUri: SANDBOX });
    expect((await s.loadInstance(instanceKey(LIVE)))?.attachmentUuidPath).toBe(PATH);
    expect((await s.loadInstance(instanceKey(SANDBOX)))?.attachmentUuidPath).toBe('');
  });

  /**
   * Blank means "write no such field", which is a real choice and the correct
   * one for the many schemas that declare no such node. Stored as given, never
   * coerced into a guess and never treated as "unset, so use the other one".
   */
  it('preserves an explicitly blank attachment path as blank', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance({ label: 'Live', baseUrl: LIVE, attachmentUuidPath: PATH }, CODE);
    await s.saveInstance({ label: 'Live', baseUrl: LIVE, attachmentUuidPath: '' }, CODE);
    expect((await s.loadInstance(instanceKey(LIVE)))?.attachmentUuidPath).toBe('');
  });

  /**
   * An OMITTED field is not a blank one. A caller that only means to rename a
   * site must not silently reset which field its attachment uuids are written
   * to -- the same rule the blank-password case above follows.
   */
  it('leaves an omitted attachment path alone rather than clearing it', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance({ label: 'Live', baseUrl: LIVE, attachmentUuidPath: PATH }, CODE);
    await s.saveInstance({ label: 'Renamed', baseUrl: LIVE }, CODE);
    const inst = await s.loadInstance(instanceKey(LIVE));
    expect(inst?.attachmentUuidPath).toBe(PATH);
    expect(inst?.label).toBe('Renamed');
  });

  /**
   * A NEW SITE IS ASSUMED LIVE. Being warned about a sandbox is a nuisance;
   * not being warned about production is an unrecoverable batch, and this tool
   * creates items with no undo into collections with no moderation workflow.
   */
  it('defaults a newly added site to live', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    const inst = await s.saveInstance({ label: 'Live', baseUrl: LIVE }, CODE);
    expect(inst.live).toBe(true);
    expect((await s.loadInstance(instanceKey(LIVE)))?.live).toBe(true);
  });

  it('round-trips a site the operator marked not live', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance({ label: 'Sandbox', baseUrl: SANDBOX, live: false }, { ...CODE, redirectUri: SANDBOX });
    expect((await s.loadInstance(instanceKey(SANDBOX)))?.live).toBe(false);
  });

  // `false` is a value, not an absence: a `??` chain that read it as one would
  // quietly re-mark a sandbox as live on the next save.
  it('does not treat "not live" as an omission on a later save', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance({ label: 'Sandbox', baseUrl: SANDBOX, live: false }, { ...CODE, redirectUri: SANDBOX });
    await s.saveInstance({ label: 'Sandbox', baseUrl: SANDBOX, live: false }, { ...CODE, redirectUri: SANDBOX });
    expect((await s.loadInstance(instanceKey(SANDBOX)))?.live).toBe(false);
  });

  /**
   * AN EXPLICIT BOOLEAN ON DISK, not a value inferred at read time.
   *
   * The operator's real store had no `live` key at all, so `undefined` reached
   * the banner and it was loud by accident rather than by decision -- and a
   * default applied when reading leaves nothing to distinguish "assumed live"
   * from "the operator said live". Asserted against the bytes rather than
   * through `loadInstance`, which would default it back and hide exactly this.
   */
  it('writes the live flag into the file as an explicit boolean', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.saveInstance({ label: 'Live', baseUrl: LIVE }, CODE);
    const onDisk = JSON.parse(fakeCipher.decrypt(await readFile(path)));
    const entry = onDisk.instances[instanceKey(LIVE)];
    expect(Object.keys(entry)).toContain('live');
    expect(entry.live).toBe(true);
  });

  it('writes an unticked live flag as false, not as an absence', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.saveInstance({ label: 'Sandbox', baseUrl: SANDBOX, live: false }, { ...CODE, redirectUri: SANDBOX });
    const onDisk = JSON.parse(fakeCipher.decrypt(await readFile(path)));
    expect(onDisk.instances[instanceKey(SANDBOX)].live).toBe(false);
  });

  // The address of the cached schema -- see Instance.schemaUuid.
  it('round-trips the chosen collection’s schema uuid', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance({ label: 'Live', baseUrl: LIVE, schemaUuid: 'schema-1' }, CODE);
    expect((await s.loadInstance(instanceKey(LIVE)))?.schemaUuid).toBe('schema-1');
  });

  // Mirrors Settings.authMode, so the renderer can say what the Sign-in button
  // will actually do without ever being handed a credential.
  it('reports how each site signs in, without any credential', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveInstance({ label: 'Live', baseUrl: LIVE }, CODE);
    await s.saveInstance(
      { label: 'Sandbox', baseUrl: SANDBOX },
      { authMode: 'password', username: 'm.rowan', password: 'hunter2' },
    );
    expect((await s.loadInstance(instanceKey(LIVE)))?.authMode).toBe('code');
    expect((await s.loadInstance(instanceKey(SANDBOX)))?.authMode).toBe('password');
    // No client secret, no password, ever. listInstances feeds the sandboxed
    // renderer (ipc.ts's InstanceChoice).
    expect(JSON.stringify(await s.listInstances())).not.toContain('shhh');
    expect(JSON.stringify(await s.listInstances())).not.toContain('hunter2');
  });

  /**
   * An entry written before these fields existed is a perfectly good
   * credential and must keep working. The defaults are the safe ones: no
   * attachment field, no schema picked, and LIVE.
   */
  it('reads an entry written before these fields existed, defaulting it to live', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({
          version: 3,
          instances: {
            [instanceKey(LIVE)]: { label: 'Live', baseUrl: LIVE, authMode: 'password' },
          },
          passwords: { [instanceKey(LIVE)]: { username: 'm.rowan', password: 'hunter2' } },
        }),
      ),
    );
    const inst = await s.loadInstance(instanceKey(LIVE));
    expect(inst?.live).toBe(true);
    expect(inst?.attachmentUuidPath).toBe('');
    expect(inst?.schemaUuid).toBe('');
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
