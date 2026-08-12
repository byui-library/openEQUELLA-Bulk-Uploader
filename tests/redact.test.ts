import { describe, it, expect } from 'vitest';
import { redactSecret, secretWireForms } from '../src/core/redact.js';

/**
 * These secrets travel in a query string built by `URLSearchParams`, so a
 * server echoing the request line back sends the form THAT encoder produces
 * -- which is not the form `encodeURIComponent` produces. The two disagree on
 * space (`+` vs `%20`) and on `!`, `'`, `(`, `)`, `~`, which
 * `encodeURIComponent` leaves literal and `URLSearchParams` escapes.
 *
 * `!` is the most common special character in institutional password policies,
 * so this is not a hypothetical gap.
 */
describe('secretWireForms', () => {
  it('yields all three encodings when they differ', () => {
    // Space and '@' make encodeURIComponent differ from the literal; space
    // and '!' make URLSearchParams differ from encodeURIComponent.
    expect(secretWireForms('p@ss word')).toEqual(
      new Set(['p@ss word', 'p%40ss%20word', 'p%40ss+word']),
    );
  });

  it('collapses to one form for a secret with no special characters', () => {
    expect(secretWireForms('correct-horse-battery-staple')).toEqual(
      new Set(['correct-horse-battery-staple']),
    );
  });

  it('is empty for an empty secret, so nothing redacts everything', () => {
    expect(secretWireForms('')).toEqual(new Set());
  });
});

describe('redactSecret', () => {
  it('redacts the literal form', () => {
    expect(redactSecret('failed for Summer2026!', 'Summer2026!')).toBe('failed for [REDACTED]');
  });

  /**
   * The regression this helper exists for. Every one of these was leaking
   * verbatim into ApiError.body before the URLSearchParams form was covered.
   */
  it.each([
    ['Summer2026!', 'Summer2026%21'],
    ['hunter!2', 'hunter%212'],
    ["o'brien~pw", 'o%27brien%7Epw'],
    ['p@ss word', 'p%40ss+word'],
    ['(paren)pw', '%28paren%29pw'],
  ])('redacts the URLSearchParams form of %j', (secret, onWire) => {
    // Confirm the fixture is honest about what goes on the wire.
    const url = new URL('https://oeq.example.edu/api/auth/login');
    url.searchParams.set('password', secret);
    expect(url.searchParams.toString()).toBe(`password=${onWire}`);

    expect(redactSecret(`server echoed ${onWire} back`, secret)).toBe('server echoed [REDACTED] back');
  });

  it('redacts the encodeURIComponent form, which differs again on space', () => {
    expect(redactSecret('echoed p%40ss%20word back', 'p@ss word')).toBe('echoed [REDACTED] back');
  });

  it('redacts every occurrence, not just the first', () => {
    expect(redactSecret('a Summer2026%21 b Summer2026! c', 'Summer2026!')).toBe(
      'a [REDACTED] b [REDACTED] c',
    );
  });

  it('leaves text alone when the secret is empty', () => {
    expect(redactSecret('nothing to hide', '')).toBe('nothing to hide');
  });

  it('leaves text that does not contain the secret untouched', () => {
    expect(redactSecret('all clear', 'Summer2026!')).toBe('all clear');
  });

  /** Base64 is the common shape for a generated OAuth secret. */
  it('redacts a base64-alphabet secret in both literal and escaped form', () => {
    const secret = 'ab+cd/ef=';
    expect(redactSecret(`body: ${secret}`, secret)).toBe('body: [REDACTED]');
    expect(redactSecret('body: ab%2Bcd%2Fef%3D', secret)).toBe('body: [REDACTED]');
  });
});
