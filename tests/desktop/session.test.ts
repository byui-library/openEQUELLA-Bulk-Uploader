import { describe, it, expect } from 'vitest';
import { buildConfig, requireInstance } from '../../src/desktop/session.js';
import type { Instance, Settings } from '../../src/desktop/secrets.js';
import { createAuthProvider } from '../../src/core/config.js';
import { UsernamePasswordAuth } from '../../src/core/passwordAuth.js';
import { AuthorizationCodeAuth } from '../../src/core/authCode.js';

// redirectUri is per-instance STORED CONFIGURATION (secrets.ts's Settings),
// never hard-coded and never derived. It is registered per OAuth client by an
// administrator; this exact value has been guessed wrong twice in this
// project (one client has no trailing slash, another has one), so buildConfig
// must pass through whatever was actually stored, verbatim.
const instance = (over: Partial<Instance> & Pick<Instance, 'id' | 'label' | 'baseUrl'>): Instance => ({
  authMode: 'code',
  // Blank is the DEFAULT and a real choice -- most schemas declare no such
  // node. See Instance.attachmentUuidPath.
  attachmentUuidPath: '',
  live: true,
  schemaUuid: '',
  ...over,
});

const LIVE: Instance = instance({
  id: 'https://oeq.example.edu',
  label: 'Live',
  baseUrl: 'https://oeq.example.edu',
});
const SANDBOX: Instance = instance({
  id: 'https://oeq-test.example.edu',
  label: 'Sandbox',
  baseUrl: 'https://oeq-test.example.edu',
});

describe('buildConfig', () => {
  it('uses the stored redirect uri verbatim, with no trailing slash', () => {
    const settings: Settings = { authMode: 'code', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://oeq.example.edu' };
    const cfg = buildConfig(LIVE, settings, 'coll-uuid');
    expect(cfg.baseUrl).toBe('https://oeq.example.edu');
    expect(cfg.redirectUri).toBe('https://oeq.example.edu');
  });

  it('uses the stored redirect uri verbatim, WITH a trailing slash, when that is what was saved', () => {
    const settings: Settings = { authMode: 'code', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://oeq-test.example.edu/' };
    const cfg = buildConfig(SANDBOX, settings, 'coll-uuid');
    expect(cfg.redirectUri).toBe('https://oeq-test.example.edu/');
  });

  // The same instance with a redirectUri saved WITHOUT a trailing slash --
  // proves buildConfig is not silently adding one back in, the way a derived
  // value would.
  it('uses the stored redirect uri verbatim, with NO trailing slash, for the same instance', () => {
    const settings: Settings = { authMode: 'code', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://oeq-test.example.edu' };
    const cfg = buildConfig(SANDBOX, settings, 'coll-uuid');
    expect(cfg.redirectUri).toBe('https://oeq-test.example.edu');
  });

  // The base url comes from the instance the operator saved, not from a list
  // the app shipped with -- there is no such list any more.
  it('takes the base url from the instance record it is given', () => {
    const settings: Settings = { authMode: 'code', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://library.example.edu/oeq' };
    const cfg = buildConfig(
      instance({
        id: 'https://library.example.edu/oeq',
        label: 'Library',
        baseUrl: 'https://library.example.edu/oeq',
      }),
      settings,
      'coll-uuid',
    );
    expect(cfg.baseUrl).toBe('https://library.example.edu/oeq');
  });

  /**
   * The blocker this task exists to remove. `buildConfig` used to pass
   * `OEQ_AUTH_MODE: 'code'` as a literal, so no matter what Setup collected
   * and no matter that `buildAuth` honours every mode correctly, the desktop
   * could only ever produce an authorization-code config -- and an
   * institution not behind SSO could not sign in at all.
   */
  it('produces a password-mode config from password-mode settings', () => {
    const settings: Settings = { authMode: 'password', username: 'm.miles', password: 'hunter2' };
    const cfg = buildConfig(LIVE, settings, 'coll-uuid');
    expect(cfg.authMode).toBe('password');
    expect(cfg.username).toBe('m.miles');
    expect(cfg.password).toBe('hunter2');
  });

  // An institution using password auth has no OAuth client at all. Demanding
  // a client id of them would make the mode unusable -- which is exactly what
  // happened while the mode was hardcoded, since loadConfig's required list
  // is mode-dependent and it was always asked for the OAuth branch.
  it('does not demand a client id or secret in password mode', () => {
    const settings: Settings = { authMode: 'password', username: 'm.miles', password: 'hunter2' };
    expect(() => buildConfig(LIVE, settings, 'coll-uuid')).not.toThrow();
    const cfg = buildConfig(LIVE, settings, 'coll-uuid');
    expect(cfg.clientId).toBe('');
    expect(cfg.clientSecret).toBe('');
  });

  it('still produces a code-mode config from OAuth settings', () => {
    const settings: Settings = {
      authMode: 'code',
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'https://oeq.example.edu',
    };
    expect(buildConfig(LIVE, settings, 'coll-uuid').authMode).toBe('code');
  });

  /**
   * The end-to-end proof that the desktop can now REACH password auth: the
   * same `createAuthProvider` the CLI uses, handed a config the desktop built,
   * returns the provider that actually signs in with a username and password.
   * Everything upstream of this can look right and still leave the operator
   * staring at openEQUELLA's "client_id (null)".
   */
  it('builds a UsernamePasswordAuth from a password-mode desktop config', () => {
    const settings: Settings = { authMode: 'password', username: 'm.miles', password: 'hunter2' };
    const provider = createAuthProvider(buildConfig(LIVE, settings, 'coll-uuid'));
    expect(provider).toBeInstanceOf(UsernamePasswordAuth);
  });

  it('still builds an AuthorizationCodeAuth from an OAuth-mode desktop config', () => {
    const settings: Settings = {
      authMode: 'code',
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'https://oeq.example.edu',
    };
    const provider = createAuthProvider(buildConfig(LIVE, settings, 'coll-uuid'));
    expect(provider).toBeInstanceOf(AuthorizationCodeAuth);
  });

  it('carries the chosen collection through', () => {
    const settings: Settings = { authMode: 'code', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://oeq.example.edu' };
    expect(buildConfig(LIVE, settings, 'abc').collectionUuid).toBe('abc');
  });
});

/**
 * The live regression this task exists to fix.
 *
 * `buildConfig` read the attachment-uuid path from
 * `process.env.OEQ_ATTACHMENT_UUID_PATH`. That works for a developer running
 * `npm run desktop` and is useless for the operator, who launches the packaged
 * app from a Start Menu shortcut with no environment set -- so a BYU-Idaho
 * operator using the GUI silently created items with no
 * `BYUI_extended/attachments/attachment` at all. No error, no warning, just
 * absent from every contribution, and nothing to notice until someone went
 * looking in openEQUELLA weeks later.
 */
describe('buildConfig and the attachment-uuid path', () => {
  const PASSWORD: Settings = { authMode: 'password', username: 'm.miles', password: 'hunter2' };
  const PATH = 'BYUI_extended/attachments/attachment';

  it('takes it from the stored instance, per site', () => {
    const cfg = buildConfig(instance({ ...LIVE, attachmentUuidPath: PATH }), PASSWORD, 'coll');
    expect(cfg.attachmentUuidPath).toBe(PATH);
  });

  // Two sites, two answers, from one process. An environment variable could
  // only ever give both the same one.
  it('is per instance, not per machine', () => {
    expect(
      buildConfig(instance({ ...LIVE, attachmentUuidPath: PATH }), PASSWORD, 'c').attachmentUuidPath,
    ).toBe(PATH);
    expect(buildConfig(SANDBOX, PASSWORD, 'c').attachmentUuidPath).toBe('');
  });

  // Blank means "write no such field", which is the right configuration for
  // the many schemas that declare no such node. It is a choice, and it is
  // never coerced into a guess.
  it('preserves blank as blank', () => {
    expect(buildConfig(instance({ ...LIVE, attachmentUuidPath: '' }), PASSWORD, 'c').attachmentUuidPath).toBe('');
  });

  /**
   * THE REGRESSION GUARD. With a stored blank and the environment variable
   * set -- which is exactly a developer's own machine -- the stored value must
   * win. An env fallback that only works where the developer sits is how this
   * hid for as long as it did.
   */
  it('ignores OEQ_ATTACHMENT_UUID_PATH in the environment entirely', () => {
    const previous = process.env.OEQ_ATTACHMENT_UUID_PATH;
    process.env.OEQ_ATTACHMENT_UUID_PATH = 'from/the/environment';
    try {
      expect(buildConfig(LIVE, PASSWORD, 'c').attachmentUuidPath).toBe('');
      expect(
        buildConfig(instance({ ...LIVE, attachmentUuidPath: PATH }), PASSWORD, 'c').attachmentUuidPath,
      ).toBe(PATH);
    } finally {
      if (previous === undefined) delete process.env.OEQ_ATTACHMENT_UUID_PATH;
      else process.env.OEQ_ATTACHMENT_UUID_PATH = previous;
    }
  });
});

// The guard that used to live in `instanceById`: an id the store knows
// nothing about is refused rather than guessed at. The lookup itself moved to
// SecretStore (instances are the operator's now), but the refusal has to stay
// somewhere, and it has to name the id so the operator can see what was asked
// for.
describe('requireInstance', () => {
  it('returns the instance when the store knew it', () => {
    expect(requireInstance('https://oeq.example.edu', LIVE)).toBe(LIVE);
  });

  it('rejects an unknown instance id rather than guessing', () => {
    expect(() => requireInstance('https://staging.example.edu', null)).toThrow(/instance/i);
    expect(() => requireInstance('https://staging.example.edu', null)).toThrow(/staging.example.edu/);
  });
});
