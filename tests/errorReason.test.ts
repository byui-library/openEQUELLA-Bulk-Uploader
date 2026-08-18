import { describe, it, expect } from 'vitest';
import { describeReason, UNSTATED_REASON } from '../src/core/errorReason.js';
import { redactSecret } from '../src/core/redact.js';

describe('describeReason', () => {
  it('reads a plain error', () => {
    expect(describeReason(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(
      'connect ECONNREFUSED 127.0.0.1:11434',
    );
  });

  /**
   * THE WHOLE REASON THIS EXISTS. Node's fetch throws `TypeError: fetch failed`
   * and hides the useful half on `cause`, so `err.message` reports the same
   * eight words for a wrong address, a stopped server and a bad certificate.
   */
  it('reads through the cause chain, where Node hides the real reason', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND oeq.example.edu'),
    });
    expect(describeReason(error)).toBe('fetch failed: getaddrinfo ENOTFOUND oeq.example.edu');
  });

  it('reads four levels, which is what the bound says', () => {
    const chain = new Error('one', {
      cause: new Error('two', { cause: new Error('three', { cause: new Error('four') }) }),
    });
    expect(describeReason(chain)).toBe('one: two: three: four');
  });

  it('stops at four, so the bound is a bound', () => {
    const chain = new Error('one', {
      cause: new Error('two', {
        cause: new Error('three', { cause: new Error('four', { cause: new Error('five') }) }),
      }),
    });
    expect(describeReason(chain)).not.toMatch(/five/);
  });

  it('survives a chain that points back at itself', () => {
    const outer = new Error('outer');
    const inner = new Error('inner', { cause: outer });
    (outer as { cause?: unknown }).cause = inner;
    expect(describeReason(outer)).toBe('outer: inner');
  });

  it('does not print a wrapper that merely repeats its cause', () => {
    const inner = new Error('connect ECONNREFUSED');
    expect(describeReason(new Error(inner.message, { cause: inner }))).toBe(
      'connect ECONNREFUSED',
    );
  });

  /** Overlapping is not duplication: discarding one of two overlapping strings
   *  is how a reader loses the half that mattered. */
  it('keeps a wrapper that merely contains its cause', () => {
    const inner = new Error('connect ECONNREFUSED');
    expect(describeReason(new Error('fetch failed: connect ECONNREFUSED', { cause: inner }))).toBe(
      'fetch failed: connect ECONNREFUSED: connect ECONNREFUSED',
    );
  });

  it('reads a thrown non-error', () => {
    expect(describeReason('a bare string')).toBe('a bare string');
    expect(describeReason(42)).toBe('42');
  });

  /** A message ending in ": " reads as a bug in the tool. */
  it('says something rather than nothing when there is nothing to read', () => {
    expect(describeReason(new Error(''))).toBe(UNSTATED_REASON);
    expect(describeReason(null)).toBe(UNSTATED_REASON);
    expect(describeReason(undefined)).toBe(UNSTATED_REASON);
  });

  it('cuts a runaway reason short', () => {
    expect(describeReason(new Error('R'.repeat(5000))).length).toBeLessThanOrEqual(200);
  });
});

/**
 * REDACT AS YOU READ, NOT AFTER YOU CUT.
 *
 * Redacting the finished string is too late: the cap can land inside the secret
 * and the redactor is handed a fragment it cannot match. This shipped once and
 * leaked up to 163 characters of a 164-character API key, so it is pinned here
 * rather than only at the one call site that noticed.
 */
describe('the redactor runs before the cut', () => {
  const SECRET = 'sk-Summer2026!pa ss';
  const redact = (text: string) => redactSecret(text, SECRET);

  /** Prefixes of eight characters and up. A whole-string search cannot see a
   *  truncation leak, which is precisely how one went unnoticed. */
  const fragments = Array.from({ length: SECRET.length - 7 }, (_, i) => SECRET.slice(0, 8 + i));

  it.each([150, 160, 164, 170, 180, 190, 195, 199])(
    'leaves no fragment when the cut lands %i characters in',
    (pad) => {
      const error = new TypeError('fetch failed', {
        cause: new Error(`${'x'.repeat(pad)} Bearer ${SECRET}`),
      });
      const reason = describeReason(error, redact);
      expect(fragments.some((fragment) => reason.includes(fragment))).toBe(false);
    },
  );

  it('redacts every level of the chain, not only the outermost', () => {
    const error = new Error('outer', {
      cause: new Error('middle', { cause: new Error(`inner holds ${SECRET}`) }),
    });
    expect(describeReason(error, redact)).not.toContain('sk-Summer');
  });

  it('leaves an unrelated reason alone', () => {
    expect(describeReason(new Error('connect ECONNREFUSED'), redact)).toBe('connect ECONNREFUSED');
  });
});
