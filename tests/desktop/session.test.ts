import { describe, it, expect } from 'vitest';
import { buildConfig } from '../../src/desktop/session.js';
import { INSTANCES } from '../../src/desktop/ipc.js';

// redirectUri is now per-instance STORED CONFIGURATION (secrets.ts's
// Settings), never hard-coded in ipc.ts's INSTANCES -- it is registered per
// OAuth client by an administrator and is not derivable from the base url.
// This exact value has been guessed wrong twice in this project (production
// has no trailing slash; one test client had one, the operator's new
// dedicated one does not), so buildConfig must pass through whatever was
// actually stored, verbatim, never re-derive or normalise it.
describe('buildConfig', () => {
  it('uses the stored redirect uri verbatim, with no trailing slash', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://content.byui.edu' };
    const cfg = buildConfig('production', settings, 'coll-uuid');
    expect(cfg.baseUrl).toBe('https://content.byui.edu');
    expect(cfg.redirectUri).toBe('https://content.byui.edu');
  });

  it('uses the stored redirect uri verbatim, WITH a trailing slash, when that is what was saved', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://content-test.byui.edu/' };
    const cfg = buildConfig('test', settings, 'coll-uuid');
    expect(cfg.redirectUri).toBe('https://content-test.byui.edu/');
  });

  // The same instance, with a redirectUri saved WITHOUT a trailing slash --
  // proves buildConfig is not silently adding one back in for 'test' the way
  // the old hard-coded INSTANCES entry always did.
  it('uses the stored redirect uri verbatim, with NO trailing slash, even for the test instance', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://content-test.byui.edu' };
    const cfg = buildConfig('test', settings, 'coll-uuid');
    expect(cfg.redirectUri).toBe('https://content-test.byui.edu');
  });

  it('carries the chosen collection through', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://content.byui.edu' };
    expect(buildConfig('production', settings, 'abc').collectionUuid).toBe('abc');
  });

  it('rejects an unknown instance id rather than guessing', () => {
    const settings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://content.byui.edu' };
    expect(() => buildConfig('staging', settings, 'x')).toThrow(/instance/i);
  });
});

// Sanity check that INSTANCES still carries what buildConfig relies on for
// baseUrl/label -- but NOT redirectUri, which no longer lives here at all
// (see the class doc comments in ipc.ts and secrets.ts).
describe('INSTANCES', () => {
  it('declares exactly production and test', () => {
    expect(INSTANCES.map((i) => i.id).sort()).toEqual(['production', 'test']);
  });

  it('no longer carries a redirectUri field', () => {
    for (const inst of INSTANCES) {
      expect((inst as unknown as Record<string, unknown>).redirectUri).toBeUndefined();
    }
  });
});
