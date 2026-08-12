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

  it('keeps a path prefix, because openEQUELLA can be hosted under one', () => {
    expect(normaliseInstanceUrl('https://library.example.edu/oeq/')).toBe(
      'https://library.example.edu/oeq',
    );
  });
});
