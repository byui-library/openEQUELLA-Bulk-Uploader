/**
 * One cached value, produced at most once at a time, discardable at any moment.
 *
 * Both auth providers need exactly this and nothing more: an OAuth token
 * (`auth.ts`) and a signed-in session (`passwordAuth.ts`). They had a
 * character-for-character copy of the logic each, linked by nothing but a
 * prose comment saying "same reasoning as the other one" -- and its semantics
 * had already been revised once under review, which is a revision that had to
 * be found and applied twice. `authCode.ts` deliberately does NOT use this: it
 * has no invalidate-mid-flight problem to solve.
 *
 * `produce` is a plain "make me a value" function. It knows nothing about
 * caching, generations or concurrency; everything subtle lives here, once.
 *
 * The three guarantees, in the order they cost the most to get right:
 *
 * 1. CONCURRENT CALLERS COLLAPSE. Five callers arriving before the first
 *    produce() settles share one produce() and one value. Under a batch run
 *    that is the difference between one token request and one per upload.
 *
 * 2. A PRODUCE() INVALIDATED MID-FLIGHT DOES NOT POPULATE THE CACHE. The
 *    caller who asked for it still receives it -- it was legitimately produced
 *    and nothing better exists to give them -- but the cache stays empty, so
 *    the next caller starts over. The concrete failure otherwise: a sign-in is
 *    in flight when client.ts takes a 401 and calls invalidate(); if that
 *    sign-in then caches, the single permitted retry goes out with a credential
 *    the server has already rejected, 401s again, and the batch dies.
 *
 * 3. A CALLER ARRIVING AFTER invalidate() DOES NOT JOIN AN OLDER PRODUCE().
 *    invalidate() means "the next call re-authenticates", full stop. Joining a
 *    produce() that predates it would hand back a value the system had already
 *    decided to discard. (This is the semantics chosen under review -- option
 *    (a) -- and the two provider tests that pin it say so.)
 *
 * Guarantees 2 and 3 are both the generation counter: invalidate() bumps it, a
 * completing produce() caches only if the generation it started under is still
 * current, and get() only joins an in-flight produce() started under the
 * current generation.
 */
export class SingleFlight<T> {
  /**
   * Boxed rather than `T | null` so a produce() that legitimately yields null
   * is still a cached value and not a permanently empty cache.
   */
  private cached: { value: T } | null = null;
  private inFlight: Promise<T> | null = null;
  /** Generation the current `inFlight` produce() was started under. */
  private inFlightGeneration: number | null = null;
  /** Bumped by invalidate(). See guarantees 2 and 3 above. */
  private generation = 0;

  constructor(private readonly produce: () => Promise<T>) {}

  async get(): Promise<T> {
    if (this.cached) return this.cached.value;
    // Collapse concurrent callers into one produce() -- but only join one that
    // started in the current generation. One predating a since-fired
    // invalidate() is not eligible to be joined; a fresh produce() is started.
    if (!this.inFlight || this.inFlightGeneration !== this.generation) {
      const startedInGeneration = this.generation;
      const promise = this.run(startedInGeneration);
      this.inFlight = promise;
      this.inFlightGeneration = startedInGeneration;
      // This cleanup chain is deliberately SEPARATE from `promise` itself:
      // callers await `promise` (via the return below) and handle its
      // rejection there. `.finally()` returns a NEW promise that rejects with
      // the same reason, and nobody awaits that one -- without the trailing
      // `.catch(() => {})` Node reports the rejection a second time as an
      // unhandled rejection, for a failure the caller already handled.
      void promise
        .finally(() => {
          if (this.inFlight === promise) {
            this.inFlight = null;
            this.inFlightGeneration = null;
          }
        })
        .catch(() => {});
    }
    return this.inFlight;
  }

  /**
   * The cached value, or null if there is none.
   *
   * Never produces one. It exists for the caller that must act on a value only
   * if it already exists -- `UsernamePasswordAuth.logout()`, which ends a live
   * server session and must not sign in a brand-new one just to end it.
   */
  peek(): T | null {
    return this.cached ? this.cached.value : null;
  }

  invalidate(): void {
    this.cached = null;
    this.generation++;
  }

  /** Produce a value, caching it only if nothing invalidated us meanwhile. */
  private async run(startedInGeneration: number): Promise<T> {
    const value = await this.produce();
    if (startedInGeneration === this.generation) {
      this.cached = { value };
    }
    return value;
  }
}
