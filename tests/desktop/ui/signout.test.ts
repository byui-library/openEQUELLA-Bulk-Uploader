import { describe, it, expect } from 'vitest';
import { signOutNotice } from '../../../src/desktop/ui/signout.js';

/**
 * SIGN OUT TELLS THE OPERATOR WHAT IT ACTUALLY MANAGED.
 *
 * `logout()` never throws, deliberately (core/passwordAuth.ts): a logout that
 * failed is not worth interrupting anyone over, and openEQUELLA expires the
 * session on its own. But "do not interrupt" was implemented as "do not say",
 * so an unreachable site and a confirmed logout produced the same signed-out
 * screen. On a shared computer that is the difference between the control
 * working and appearing to -- and the operator has a real remedy, which is why
 * the notice names it rather than telling them to try again. Trying again
 * cannot work: the session this process was holding has already been dropped
 * locally, so there is nothing left here to log out with.
 */
describe('the sign-out notice', () => {
  it('says nothing when every session was confirmed ended', () => {
    expect(signOutNotice({ sessions: 2, unconfirmed: 0 })).toBeNull();
  });

  /**
   * Nothing to end is not a doubt. In OAuth mode, or on a fresh launch, the
   * app holds no openEQUELLA session at all; warning about one would train the
   * operator to ignore the message on the day it means something.
   */
  it('says nothing when there was no session to end', () => {
    expect(signOutNotice({ sessions: 0, unconfirmed: 0 })).toBeNull();
  });

  it('speaks up when the site did not confirm the session ended', () => {
    const notice = signOutNotice({ sessions: 1, unconfirmed: 1 });
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/signed out on this computer/i);
    expect(notice).toMatch(/did not confirm/i);
  });

  /**
   * THE WORDING HAS TO BE ACTIONABLE, which for this failure means two facts:
   * the session expires by itself, so most operators need do nothing, and
   * anyone who cannot wait -- a shared machine -- can end it from a browser.
   * "Try again" would be worse than silence: there is nothing left in this
   * process to retry with.
   */
  it('names the remedy: it expires on its own, or sign out in a browser', () => {
    const notice = signOutNotice({ sessions: 1, unconfirmed: 1 })!;
    expect(notice).toMatch(/expire/i);
    expect(notice).toMatch(/browser/i);
    expect(notice).toMatch(/shared computer/i);
    expect(notice).not.toMatch(/try again/i);
  });

  // One unconfirmed among several is still a live session somewhere.
  it('speaks up when only one of several could not be confirmed', () => {
    expect(signOutNotice({ sessions: 3, unconfirmed: 1 })).not.toBeNull();
  });
});
