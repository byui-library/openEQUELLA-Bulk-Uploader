import { describe, it, expect } from 'vitest';
import { SingleFlight } from '../src/core/singleFlight.js';

/**
 * A produce() that never settles on its own, so a test can hold one "in
 * flight" and decide exactly when it finishes.
 *
 * Deliberately a plain counter rather than a fetch stub: the thing under test
 * is the collapsing and generation logic, and a network stub would only add a
 * second thing that could be wrong. Each call yields a distinct value so a
 * test can tell WHICH produce a caller was served by -- a fixed value cannot
 * distinguish "produced again" from "handed back the stale one".
 */
function deferred() {
  const pending: Array<{ id: string; settle: () => void; fail: (e: unknown) => void }> = [];
  let started = 0;
  const produce = (): Promise<string> => {
    started += 1;
    const id = `value-${started}`;
    return new Promise<string>((resolve, reject) => {
      pending.push({ id, settle: () => resolve(id), fail: reject });
    });
  };
  return {
    produce,
    get started() {
      return started;
    },
    /** Settle the nth (1-based) produce that was started. */
    settle(n: number) {
      pending[n - 1]!.settle();
    },
    fail(n: number, error: unknown) {
      pending[n - 1]!.fail(error);
    },
  };
}

/** A produce() that resolves immediately, counting its calls. */
function immediate() {
  let started = 0;
  return {
    produce: async () => {
      started += 1;
      return `value-${started}`;
    },
    get started() {
      return started;
    },
  };
}

describe('SingleFlight', () => {
  it('produces a value and hands it to the caller', async () => {
    const source = immediate();
    const flight = new SingleFlight(source.produce);
    expect(await flight.get()).toBe('value-1');
  });

  it('caches the value across calls', async () => {
    const source = immediate();
    const flight = new SingleFlight(source.produce);
    await flight.get();
    await flight.get();
    expect(source.started).toBe(1);
  });

  it('produces again after invalidate()', async () => {
    const source = immediate();
    const flight = new SingleFlight(source.produce);
    expect(await flight.get()).toBe('value-1');
    flight.invalidate();
    expect(await flight.get()).toBe('value-2');
    expect(source.started).toBe(2);
  });

  /** BEHAVIOUR 1. Concurrent callers collapse into one produce(). */
  it('collapses concurrent callers into a single produce()', async () => {
    const source = deferred();
    const flight = new SingleFlight(source.produce);
    const all = Promise.all([flight.get(), flight.get(), flight.get(), flight.get(), flight.get()]);
    expect(source.started).toBe(1);
    source.settle(1);
    const values = await all;
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe('value-1');
    expect(source.started).toBe(1);
  });

  /**
   * BEHAVIOUR 2. A produce() invalidated mid-flight does not populate the
   * cache. Its result is still handed to the caller who asked for it -- that
   * value was legitimately produced -- but the next caller starts fresh rather
   * than being served something the system already decided to discard.
   */
  it('does not cache a value whose produce() was invalidated mid-flight', async () => {
    const source = deferred();
    const flight = new SingleFlight(source.produce);
    const first = flight.get();
    flight.invalidate(); // lands while produce #1 is in flight
    source.settle(1);
    expect(await first).toBe('value-1'); // the caller still gets it

    const second = flight.get();
    expect(source.started).toBe(2); // …but nothing was cached, so it produces again
    source.settle(2);
    expect(await second).toBe('value-2');

    // And THAT one was cached, so a third caller makes no produce() call.
    expect(await flight.get()).toBe('value-2');
    expect(source.started).toBe(2);
  });

  /**
   * BEHAVIOUR 3. invalidate() means the NEXT caller starts over, full stop. A
   * caller arriving after it must not silently join a produce() that predates
   * it and receive a value already disowned.
   */
  it('does not let a caller arriving after invalidate() join an older produce()', async () => {
    const source = deferred();
    const flight = new SingleFlight(source.produce);
    const first = flight.get();
    flight.invalidate();
    const second = flight.get(); // arrived AFTER invalidate() -- must not join #1
    expect(source.started).toBe(2);

    source.settle(1);
    source.settle(2);
    const [firstValue, secondValue] = await Promise.all([first, second]);
    expect(firstValue).toBe('value-1');
    expect(secondValue).toBe('value-2');
    expect(secondValue).not.toBe(firstValue);
  });

  it('still collapses callers who arrive after an invalidate(), among themselves', async () => {
    const source = deferred();
    const flight = new SingleFlight(source.produce);
    void flight.get();
    flight.invalidate();
    const second = flight.get();
    const third = flight.get();
    expect(source.started).toBe(2);
    source.settle(1);
    source.settle(2);
    expect(await second).toBe('value-2');
    expect(await third).toBe('value-2');
  });

  it('caches nothing when produce() rejects, so the next caller tries again', async () => {
    const source = deferred();
    const flight = new SingleFlight(source.produce);
    const first = flight.get();
    source.fail(1, new Error('nope'));
    await expect(first).rejects.toThrow('nope');
    const second = flight.get();
    expect(source.started).toBe(2);
    source.settle(2);
    expect(await second).toBe('value-2');
  });

  /**
   * The cleanup chain that clears `inFlight` is deliberately SEPARATE from the
   * promise callers await, and ends in `.catch(() => {})`. Without that catch,
   * a rejected produce() is reported twice: once by whoever awaited get(), and
   * again by the derived promise `.finally()` returns, which nobody handles --
   * Node reports the second as an unhandled rejection and can abort the
   * process. The caller handled it; the bookkeeping must not re-raise it.
   */
  it('does not report a rejection a second time as an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const record = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', record);
    try {
      const source = deferred();
      const flight = new SingleFlight(source.produce);
      const first = flight.get();
      source.fail(1, new Error('boom'));
      await expect(first).rejects.toThrow('boom');
      // Node emits unhandledRejection after the microtask queue drains, so
      // give it a macrotask to notice.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  describe('peek()', () => {
    it('is null before anything has been produced, and starts nothing', async () => {
      const source = immediate();
      const flight = new SingleFlight(source.produce);
      expect(flight.peek()).toBeNull();
      expect(source.started).toBe(0);
    });

    it('is the cached value once one has been produced', async () => {
      const source = immediate();
      const flight = new SingleFlight(source.produce);
      await flight.get();
      expect(flight.peek()).toBe('value-1');
      expect(source.started).toBe(1);
    });

    it('is null again after invalidate()', async () => {
      const source = immediate();
      const flight = new SingleFlight(source.produce);
      await flight.get();
      flight.invalidate();
      expect(flight.peek()).toBeNull();
    });

    it('is null while a produce() is still in flight', async () => {
      const source = deferred();
      const flight = new SingleFlight(source.produce);
      const first = flight.get();
      expect(flight.peek()).toBeNull();
      source.settle(1);
      await first;
      expect(flight.peek()).toBe('value-1');
    });
  });
});
