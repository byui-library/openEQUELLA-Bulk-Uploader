import { describe, it, expect } from 'vitest';
import { normaliseInstanceUrl, instanceKey } from '../src/core/instanceUrl.js';

describe('normaliseInstanceUrl', () => {
  it('strips trailing slashes so callers can concatenate paths', () => {
    expect(normaliseInstanceUrl('https://oeq.example.edu/')).toBe('https://oeq.example.edu');
    expect(normaliseInstanceUrl('https://oeq.example.edu///')).toBe('https://oeq.example.edu');
  });

  /**
   * openEQUELLA takes the password as a QUERY PARAMETER on /api/auth/login.
   * Over plaintext that puts it in the clear on the wire, so this is refused
   * rather than warned about -- there is no safe way to proceed.
   */
  it('refuses plaintext http, naming the reason', () => {
    expect(() => normaliseInstanceUrl('http://oeq.example.edu')).toThrow(/https/i);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => normaliseInstanceUrl('oeq.example.edu')).toThrow();
    expect(() => normaliseInstanceUrl('')).toThrow();
  });

  /**
   * Blank is the empty-form case, not a malformed address, and quoting the
   * empty string back ('"" is not a web address') tells the operator nothing.
   */
  it('asks for an address when given nothing, rather than quoting nothing back', () => {
    expect(() => normaliseInstanceUrl('   ')).toThrow(/Enter the address/i);
    expect(() => normaliseInstanceUrl('')).not.toThrow(/is not a web address/);
  });

  /**
   * 'htps://...' parses happily as a URL with an unknown scheme, so it reaches
   * the protocol check. It is a typo, and pairing a typo with a lecture about
   * password exposure is confusing noise -- that explanation belongs to http,
   * where the operator might actually argue the point.
   */
  it('treats a misspelled scheme as a typo, without the password lecture', () => {
    expect(() => normaliseInstanceUrl('htps://oeq.example.edu')).toThrow(/https/i);
    expect(() => normaliseInstanceUrl('htps://oeq.example.edu')).not.toThrow(/password/i);
  });

  it('still explains the risk for plaintext http specifically', () => {
    expect(() => normaliseInstanceUrl('http://oeq.example.edu')).toThrow(/password/i);
  });

  it('keeps a path prefix, because openEQUELLA can be hosted under one', () => {
    expect(normaliseInstanceUrl('https://library.example.edu/oeq/')).toBe(
      'https://library.example.edu/oeq',
    );
  });
});

describe('instanceKey', () => {
  /**
   * The key an instance's credentials are stored under (desktop/secrets.ts).
   * It is DERIVED from the normalised address rather than typed, so two
   * spellings of one site cannot end up as two entries -- which would mean
   * the operator retyping a client secret for a site they had already
   * configured, and two copies of it drifting apart afterwards.
   */
  it('gives one key to two spellings of the same address', () => {
    expect(instanceKey('https://oeq.example.edu/')).toBe(instanceKey('https://oeq.example.edu'));
    expect(instanceKey('  https://oeq.example.edu///  ')).toBe(instanceKey('https://oeq.example.edu'));
  });

  it('keeps different sites apart', () => {
    expect(instanceKey('https://a.example.edu')).not.toBe(instanceKey('https://b.example.edu'));
    // A path prefix is part of the address, not decoration: openEQUELLA can
    // be hosted under one, and two such sites can share a host.
    expect(instanceKey('https://x.example.edu/oeq')).not.toBe(instanceKey('https://x.example.edu'));
  });

  it('refuses an address normaliseInstanceUrl refuses, rather than keying off a bad one', () => {
    expect(() => instanceKey('http://oeq.example.edu')).toThrow(/https/i);
    expect(() => instanceKey('   ')).toThrow(/Enter the address/i);
  });
});
