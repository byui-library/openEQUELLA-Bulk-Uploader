import { describe, it, expect } from 'vitest';
import { buildConfig, requireInstance } from '../../src/desktop/session.js';
import type { Instance } from '../../src/desktop/secrets.js';

// redirectUri is per-instance STORED CONFIGURATION (secrets.ts's Settings),
// never hard-coded and never derived. It is registered per OAuth client by an
// administrator; this exact value has been guessed wrong twice in this
// project (one client has no trailing slash, another has one), so buildConfig
// must pass through whatever was actually stored, verbatim.
const LIVE: Instance = { id: 'https://oeq.example.edu', label: 'Live', baseUrl: 'https://oeq.example.edu' };
const SANDBOX: Instance = {
  id: 'https://oeq-test.example.edu',
  label: 'Sandbox',
  baseUrl: 'https://oeq-test.example.edu',
};

describe('buildConfig', () => {
  it('uses the stored redirect uri verbatim, with no trailing slash', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://oeq.example.edu' };
    const cfg = buildConfig(LIVE, settings, 'coll-uuid');
    expect(cfg.baseUrl).toBe('https://oeq.example.edu');
    expect(cfg.redirectUri).toBe('https://oeq.example.edu');
  });

  it('uses the stored redirect uri verbatim, WITH a trailing slash, when that is what was saved', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://oeq-test.example.edu/' };
    const cfg = buildConfig(SANDBOX, settings, 'coll-uuid');
    expect(cfg.redirectUri).toBe('https://oeq-test.example.edu/');
  });

  // The same instance with a redirectUri saved WITHOUT a trailing slash --
  // proves buildConfig is not silently adding one back in, the way a derived
  // value would.
  it('uses the stored redirect uri verbatim, with NO trailing slash, for the same instance', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://oeq-test.example.edu' };
    const cfg = buildConfig(SANDBOX, settings, 'coll-uuid');
    expect(cfg.redirectUri).toBe('https://oeq-test.example.edu');
  });

  // The base url comes from the instance the operator saved, not from a list
  // the app shipped with -- there is no such list any more.
  it('takes the base url from the instance record it is given', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://library.example.edu/oeq' };
    const cfg = buildConfig(
      { id: 'https://library.example.edu/oeq', label: 'Library', baseUrl: 'https://library.example.edu/oeq' },
      settings,
      'coll-uuid',
    );
    expect(cfg.baseUrl).toBe('https://library.example.edu/oeq');
  });

  it('carries the chosen collection through', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://oeq.example.edu' };
    expect(buildConfig(LIVE, settings, 'abc').collectionUuid).toBe('abc');
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
