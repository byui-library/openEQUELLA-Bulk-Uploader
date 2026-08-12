import { describe, it, expect } from 'vitest';
import { normaliseInstanceUrl } from '../src/core/instanceUrl.js';

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
