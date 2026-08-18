// tests/desktop/signinCapture.test.ts
import { describe, it, expect } from 'vitest';
import { decideCapture } from '../../src/desktop/signin.js';

/**
 * ## The sign-in window's capture rule, testable without Electron
 *
 * `signInInteractive` cannot be unit-tested: it constructs a `BrowserWindow`.
 * That left the decision it makes on every navigation -- ignore this URL,
 * accept this code, or refuse a forged one -- verified by reading only, which
 * is exactly the standard this project keeps finding insufficient.
 *
 * So the decision is a pure function and the window is left with the wiring.
 * `extractOeqError` in the same module is already split out for the same
 * reason.
 */

/** Stands in for `AuthorizationCodeAuth.checkState`. */
const expecting = (state: string) => (received: string | null | undefined) =>
  received === state;

const ORIGIN = 'https://oeq.example.edu';

describe('decideCapture', () => {
  it('accepts a code that carries back the state we sent', () => {
    expect(
      decideCapture(`${ORIGIN}/?code=the-code&state=ours`, ORIGIN, expecting('ours')),
    ).toEqual({ kind: 'code', code: 'the-code' });
  });

  /**
   * The one that matters. Without this the window accepted whatever arrived
   * carrying a `code`.
   */
  it('refuses a code whose state is not ours', () => {
    expect(
      decideCapture(`${ORIGIN}/?code=stolen&state=theirs`, ORIGIN, expecting('ours')),
    ).toEqual({ kind: 'forged' });
  });

  it('refuses a code that carries no state at all', () => {
    expect(decideCapture(`${ORIGIN}/?code=stolen`, ORIGIN, expecting('ours'))).toEqual({
      kind: 'forged',
    });
  });

  /**
   * Signing in via SSO also produces a `?code=` on the identity provider's own
   * host, and exchanging that one fails obscurely. Load-bearing, and learned
   * from a live run.
   */
  it('ignores a code from another origin entirely', () => {
    expect(
      decideCapture('https://sso.example.org/?code=other&state=ours', ORIGIN, expecting('ours')),
    ).toEqual({ kind: 'ignore' });
  });

  /**
   * The authorize URL itself carries the state as a REQUEST parameter. Reading
   * a code off it would capture nothing useful, and this guard predates the
   * state check.
   */
  it('ignores the authorize URL itself', () => {
    expect(
      decideCapture(`${ORIGIN}/oauth/authorise?client_id=x&state=ours`, ORIGIN, expecting('ours')),
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores a page on our origin that carries no code', () => {
    expect(decideCapture(`${ORIGIN}/page/home`, ORIGIN, expecting('ours'))).toEqual({
      kind: 'ignore',
    });
  });

  it('ignores something that is not a URL', () => {
    expect(decideCapture('about:blank#not a url', ORIGIN, expecting('ours'))).toEqual({
      kind: 'ignore',
    });
  });

  /**
   * A path prefix is normal -- openEQUELLA is commonly deployed under one --
   * and the origin is what the rule is about, so a code on a prefixed path is
   * still ours.
   */
  it('accepts a code on a path under our origin', () => {
    expect(
      decideCapture(`${ORIGIN}/oeq/page/home?code=the-code&state=ours`, ORIGIN, expecting('ours')),
    ).toEqual({ kind: 'code', code: 'the-code' });
  });
});
