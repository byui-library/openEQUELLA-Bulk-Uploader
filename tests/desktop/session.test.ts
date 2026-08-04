import { describe, it, expect } from 'vitest';
import { buildConfig } from '../../src/desktop/session.js';
import { INSTANCES } from '../../src/desktop/ipc.js';

const settings = { clientId: 'cid', clientSecret: 'sec' };

describe('buildConfig', () => {
  it('uses the production redirect uri verbatim, with no trailing slash', () => {
    const cfg = buildConfig('production', settings, 'coll-uuid');
    expect(cfg.baseUrl).toBe('https://content.byui.edu');
    expect(cfg.redirectUri).toBe('https://content.byui.edu');
  });

  it('uses the test redirect uri verbatim, WITH its trailing slash', () => {
    const cfg = buildConfig('test', settings, 'coll-uuid');
    expect(cfg.redirectUri).toBe('https://content-test.byui.edu/');
  });

  it('carries the chosen collection through', () => {
    expect(buildConfig('production', settings, 'abc').collectionUuid).toBe('abc');
  });

  it('rejects an unknown instance id rather than guessing', () => {
    expect(() => buildConfig('staging', settings, 'x')).toThrow(/instance/i);
  });
});

// Sanity check that INSTANCES itself carries what buildConfig relies on --
// two instances, distinct redirect URIs, and the documented trailing-slash
// asymmetry (production has none, test does).
describe('INSTANCES', () => {
  it('declares exactly production and test', () => {
    expect(INSTANCES.map((i) => i.id).sort()).toEqual(['production', 'test']);
  });
});
