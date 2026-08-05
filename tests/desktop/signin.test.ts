import { describe, it, expect, vi } from 'vitest';
import { resolveSignIn, extractOeqError } from '../../src/desktop/signin.js';

/** A promise plus its externally-callable resolver, for controlling timing from a test. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('resolveSignIn', () => {
  it('resolves with the code when it arrives with no load error at all', async () => {
    const code = deferred<string>();
    const loadError = deferred<Error>(); // never resolves in this test
    const delay = vi.fn(() => new Promise<void>(() => {})); // must never be consulted

    const result = resolveSignIn({ code: code.promise, loadError: loadError.promise, graceMs: 1000, delay });
    code.resolve('abc123');

    await expect(result).resolves.toBe('abc123');
    expect(delay).not.toHaveBeenCalled();
  });

  it('ignores a load error and succeeds when the code arrives before the grace period expires', async () => {
    const code = deferred<string>();
    const loadError = deferred<Error>();
    // Never resolves on its own -- if the implementation actually waited out
    // the full grace period instead of noticing the code, this test would
    // hang and time out, which is exactly the failure mode to catch.
    const delay = vi.fn(() => new Promise<void>(() => {}));

    const result = resolveSignIn({ code: code.promise, loadError: loadError.promise, graceMs: 3000, delay });

    loadError.resolve(new Error('net::ERR_FAILED (-2)'));
    code.resolve('captured-during-grace');

    await expect(result).resolves.toBe('captured-during-grace');
    expect(delay).toHaveBeenCalledWith(3000);
  });

  it('rejects with a message including the load error once the grace period expires with no code', async () => {
    const code = deferred<string>(); // never resolves
    const loadError = deferred<Error>();
    const delay = vi.fn(() => Promise.resolve()); // grace period "expires" immediately

    const result = resolveSignIn({ code: code.promise, loadError: loadError.promise, graceMs: 10, delay });

    loadError.resolve(new Error('net::ERR_FAILED (-2)'));

    await expect(result).rejects.toThrow(/net::ERR_FAILED \(-2\)/);
  });

  it('never calls delay when the code wins the very first race outright', async () => {
    const code = deferred<string>();
    const loadError = deferred<Error>();
    const delay = vi.fn(() => Promise.resolve());

    const result = resolveSignIn({ code: code.promise, loadError: loadError.promise, graceMs: 5, delay });
    code.resolve('fast-code');

    await expect(result).resolves.toBe('fast-code');
    expect(delay).not.toHaveBeenCalled();
  });
});

// LIVE BUG: the operator's first sign-in failure surfaced
// "Sign-in could not load openEQUELLA: ERR_FAILED (-2) loading
// '.../oauth/authorise?...'" -- a transport error -- when the page
// openEQUELLA actually rendered named exactly what was wrong: "No OAuth
// client can be found with the supplied client_id (...) and redirect_uri
// (...)" under a "Problem description:" heading. extractOeqError is the
// pure text-parsing half of that fix (signInInteractive wires it to the
// live BrowserWindow, which isn't unit-testable here).
describe('extractOeqError', () => {
  it('extracts the message following "Problem description:"', () => {
    const pageText = [
      'There was a problem',
      '',
      'Problem description: No OAuth client can be found with the supplied client_id',
      '(165e12ca-f516-4218-8bc2-201183424ef1) and redirect_uri (https://content-test.byui.edu/)',
      '',
      'Return to application',
    ].join('\n');

    expect(extractOeqError(pageText)).toBe(
      'No OAuth client can be found with the supplied client_id ' +
        '(165e12ca-f516-4218-8bc2-201183424ef1) and redirect_uri (https://content-test.byui.edu/)',
    );
  });

  it('is case-insensitive about the "Problem description" heading', () => {
    const pageText = 'PROBLEM DESCRIPTION: something specific went wrong';
    expect(extractOeqError(pageText)).toBe('something specific went wrong');
  });

  it('returns null for unrelated page text', () => {
    const pageText = 'Sign in to openEQUELLA\nUsername\nPassword\nLog in';
    expect(extractOeqError(pageText)).toBeNull();
  });

  it('returns null for empty page text', () => {
    expect(extractOeqError('')).toBeNull();
  });

  it('returns null when the heading is present but nothing follows it', () => {
    expect(extractOeqError('Problem description:   ')).toBeNull();
  });
});
