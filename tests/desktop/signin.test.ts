import { describe, it, expect, vi } from 'vitest';
import { resolveSignIn } from '../../src/desktop/signin.js';

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
