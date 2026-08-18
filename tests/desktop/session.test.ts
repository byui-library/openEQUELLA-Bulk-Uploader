import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuth,
  buildConfig,
  endAllSessions,
  endSessionsFor,
  forgetLiveSessions,
  requireInstance,
} from '../../src/desktop/session.js';
import type { Instance, Settings } from '../../src/desktop/secrets.js';
import { createAuthProvider } from '../../src/core/config.js';
import { FileTokenStore } from '../../src/core/tokenStore.js';
import { UsernamePasswordAuth, type LogoutOutcome } from '../../src/core/passwordAuth.js';
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
    const settings: Settings = { authMode: 'password', username: 'm.rowan', password: 'hunter2' };
    const cfg = buildConfig(LIVE, settings, 'coll-uuid');
    expect(cfg.authMode).toBe('password');
    expect(cfg.username).toBe('m.rowan');
    expect(cfg.password).toBe('hunter2');
  });

  // An institution using password auth has no OAuth client at all. Demanding
  // a client id of them would make the mode unusable -- which is exactly what
  // happened while the mode was hardcoded, since loadConfig's required list
  // is mode-dependent and it was always asked for the OAuth branch.
  it('does not demand a client id or secret in password mode', () => {
    const settings: Settings = { authMode: 'password', username: 'm.rowan', password: 'hunter2' };
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
    const settings: Settings = { authMode: 'password', username: 'm.rowan', password: 'hunter2' };
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
  const PASSWORD: Settings = { authMode: 'password', username: 'm.rowan', password: 'hunter2' };
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

/**
 * ENDING A SESSION MEANS ENDING THE ONE THAT ALREADY EXISTS.
 *
 * `UsernamePasswordAuth.logout()` can only end the session held by the
 * provider it is called on, and a provider that has never signed in makes no
 * request at all (tests/passwordAuth.test.ts, "makes no request at all when
 * there was never a session"). So a desktop that discards every provider the
 * moment a handler returns has nothing left to log out: building a fresh one
 * to log out with would sign in first and then end THAT session, leaving the
 * real one alive on the server. The registry is what keeps the providers
 * reachable, so nothing ever has to sign in in order to sign out.
 */
describe('live session registry', () => {
  const PASSWORD: Settings = { authMode: 'password', username: 'm.rowan', password: 'hunter2' };
  const OAUTH: Settings = {
    authMode: 'code',
    clientId: 'cid',
    clientSecret: 'sec',
    redirectUri: 'https://oeq.example.edu',
  };

  let dir: string;
  beforeEach(async () => {
    forgetLiveSessions();
    dir = await mkdtemp(join(tmpdir(), 'oeq-live-sessions-'));
  });
  afterEach(async () => {
    forgetLiveSessions();
    await rm(dir, { recursive: true, force: true });
  });

  const store = () => new FileTokenStore(join(dir, 'token.json'));

  /** Spy on the real provider's own logout, so the object under test is the
   *  one the handlers actually got back. With no session established it makes
   *  no request, so nothing here touches the network. Reports `'ended'`, which
   *  is what a real one does when the server confirms (core/passwordAuth.ts). */
  function watchLogout(provider: unknown, outcome: LogoutOutcome = 'ended'): ReturnType<typeof vi.fn> {
    const spy = vi.fn(async () => outcome);
    (provider as { logout: () => Promise<LogoutOutcome> }).logout = spy;
    return spy;
  }

  it('keeps the provider a password-mode sign-in would establish its session on', async () => {
    const provider = buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id);
    const logout = watchLogout(provider);

    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 1, unconfirmed: 0 });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  /**
   * An OAuth provider holds a bearer token, not a server session, and has no
   * `logout()` at all. Registering one would mean the quit hook reporting
   * sessions it did not end.
   */
  it('keeps nothing for an OAuth instance, which holds no server session', async () => {
    buildAuth(buildConfig(LIVE, OAUTH, 'coll'), store(), LIVE.id);
    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 0, unconfirmed: 0 });
  });

  it('ends nothing for an instance that was never signed in to', async () => {
    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 0, unconfirmed: 0 });
  });

  // Credentials are per instance and so are sessions. Forgetting one site's
  // password must not end the session the operator has open on another.
  it('ends only the instance asked for', async () => {
    const live = watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id));
    const sandbox = watchLogout(buildAuth(buildConfig(SANDBOX, PASSWORD, 'coll'), store(), SANDBOX.id));

    expect(await endSessionsFor(SANDBOX.id)).toEqual({ sessions: 1, unconfirmed: 0 });
    expect(sandbox).toHaveBeenCalledTimes(1);
    expect(live).not.toHaveBeenCalled();
  });

  // Every handler call builds its own provider, so a site can hold several
  // sessions at once. Ending "the" session would leave the rest alive.
  it('ends every session an instance accumulated, not just the newest', async () => {
    const first = watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id));
    const second = watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id));

    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 2, unconfirmed: 0 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('forgets what it has ended, so a second call ends nothing again', async () => {
    const logout = watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id));
    await endSessionsFor(LIVE.id);

    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 0, unconfirmed: 0 });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('ends every instance at once for the quit hook', async () => {
    const live = watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id));
    const sandbox = watchLogout(buildAuth(buildConfig(SANDBOX, PASSWORD, 'coll'), store(), SANDBOX.id));

    expect(await endAllSessions()).toEqual({ sessions: 2, unconfirmed: 0 });
    expect(live).toHaveBeenCalledTimes(1);
    expect(sandbox).toHaveBeenCalledTimes(1);
  });

  /**
   * A SITE'S SESSIONS DO NOT ALL SUCCEED OR ALL FAIL. Each handler call built
   * its own provider and each holds its own JSESSIONID, so one PUT can be
   * answered and the next refused. Reporting one number for the pair would
   * either raise an alarm about a session that did end, or hide one that did
   * not -- and the second is how a live session gets presented as closed.
   */
  it('aggregates a confirmed logout and an unconfirmed one across two providers', async () => {
    const first = watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id), 'ended');
    const second = watchLogout(
      buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id),
      'unconfirmed',
    );

    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 2, unconfirmed: 1 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  // The quit hook's view of the same thing: one site clean, another not.
  it('aggregates across instances too', async () => {
    watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id), 'ended');
    watchLogout(buildAuth(buildConfig(SANDBOX, PASSWORD, 'coll'), store(), SANDBOX.id), 'unconfirmed');

    expect(await endAllSessions()).toEqual({ sessions: 2, unconfirmed: 1 });
  });

  /**
   * A provider that had nothing to end is not a failure. `logout()` answers
   * `'no-session'` when it never signed in, and counting that as unconfirmed
   * would put "we could not confirm your session ended" in front of an
   * operator who never had one -- a warning about nothing, on the screen where
   * a real one has to be believed.
   */
  it('does not call a session it never had unconfirmed', async () => {
    watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id), 'no-session');

    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 1, unconfirmed: 0 });
  });

  /**
   * `logout()` never throws (core/passwordAuth.ts), so a provider that does
   * has broken its contract -- and the registry has to survive it without
   * either propagating (both callers would have to swallow it again, which is
   * where the "signed out" lie came from) or counting it as ended. It is
   * reported as exactly what it is: unconfirmed.
   *
   * What it must not do either way is hand the same dead provider back on the
   * next call: the session is gone from this process regardless, exactly as
   * `logout()` itself drops it locally first.
   */
  it('reports a thrown logout as unconfirmed, and still drops the session', async () => {
    const provider = buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id);
    (provider as unknown as { logout: () => Promise<LogoutOutcome> }).logout = async () => {
      throw new Error('connect ECONNREFUSED');
    };

    await expect(endSessionsFor(LIVE.id)).resolves.toEqual({ sessions: 1, unconfirmed: 1 });
    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 0, unconfirmed: 0 });
  });

  /** One provider throwing must not stop the rest being ended -- a failure on
   *  the first would otherwise leave every later session live. */
  it('ends the other sessions even when one throws', async () => {
    const provider = buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id);
    (provider as unknown as { logout: () => Promise<LogoutOutcome> }).logout = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const other = watchLogout(buildAuth(buildConfig(LIVE, PASSWORD, 'coll'), store(), LIVE.id));

    expect(await endSessionsFor(LIVE.id)).toEqual({ sessions: 2, unconfirmed: 1 });
    expect(other).toHaveBeenCalledTimes(1);
  });
});
