import type { SessionEndReport } from '../ipc.js';

/**
 * What Sign out owes the operator when the site never confirmed the session
 * ended.
 *
 * `UsernamePasswordAuth.logout()` never throws, and must not: a logout that
 * failed is not worth interrupting anyone over, the local session is dropped
 * either way, and openEQUELLA expires the server one regardless. NOT
 * INTERRUPTING IS NOT THE SAME AS NOT SAYING, though, and it used to be
 * implemented as if it were -- an unreachable site, a 500, and a confirmed
 * logout all produced the same signed-out screen with nothing on it. The
 * operator was told they were signed out: true of this computer, unknown of
 * the server, and on a shared machine that is the difference between the
 * control working and appearing to.
 *
 * NULL WHEN THERE IS NOTHING TO SAY, including when there was no session to
 * end at all -- OAuth mode, or a launch that never signed in. A warning that
 * fires on every sign-out stops being a warning, which this project has
 * already learnt once from a banner (ui/banner.ts).
 *
 * THE WORDING NAMES A REMEDY, and deliberately not "try again": the session
 * this process was holding has already been dropped locally, so there is
 * nothing left here to retry with, and a second click would end nothing.
 * What an operator can actually do is nothing (it expires by itself) or,
 * if they cannot wait because the computer is shared, sign out of openEQUELLA
 * in a browser -- where their own session is reachable.
 *
 * The sentence is kept on one source line, as `setupNotice` is: wrapping it
 * would put a newline inside it, and anyone grepping for the wording an
 * operator reported would then miss it.
 */
export function signOutNotice(report: SessionEndReport): string | null {
  if (report.unconfirmed === 0) return null;
  return "You're signed out on this computer, but the site did not confirm that your openEQUELLA session ended. It will expire on its own. On a shared computer, sign out of openEQUELLA in a web browser to be certain.";
}
