import type { CurrentUser } from './client.js';
import { ValidationError } from './errors.js';

/**
 * The one explanation of what a guest session is, shared by every front end.
 *
 * openEQUELLA NEVER answers an unauthenticated request with 401. Measured
 * against content-test.byui.edu with no credentials at all, `GET
 * /api/content/currentuser` returned 200 and
 * `{"id":"guest","username":"guest","guest":true,...}`, and `GET
 * /api/collection?privilege=CREATE_ITEM` returned 200 with `available: 29` and
 * zero results -- "there are 29; you get none". Both recorded in
 * tests/fixtures/api/.
 *
 * That is why this sentence exists in one place rather than three: every
 * surface that confirms a sign-in has the same wrong assumption available to
 * it (that a successful call means somebody is signed in), and each one that
 * words the correction itself is a chance for them to disagree about what
 * happened -- exactly the reason `runPreflight` is shared between the CLI and
 * the MCP server.
 */
export const GUEST_SESSION_EXPLANATION =
  'openEQUELLA answers as the guest user, which means nobody is signed in. Nothing can be ' +
  'created in this state, and the list of collections comes back empty even where collections ' +
  'exist. openEQUELLA does not report this as an error -- an unauthenticated request gets a ' +
  'normal-looking response and no 401 -- so a sign-in that appeared to work can end up here.';

/**
 * The user, or a refusal if the "user" is the guest identity.
 *
 * A SUCCESSFUL `currentUser()` IS NOT PROOF OF SIGN-IN, and every caller that
 * treated it as one is a place this tool told somebody they were signed in
 * when they were not. `remedy` is the calling front end's own next step --
 * a CLI command, an MCP tool, a screen -- for the same reason
 * `runPreflight` takes a `loginHint`: "Run: oeq-upload login" is correct for a
 * terminal and meaningless in a desktop app with no shell.
 */
export function assertNotGuest(user: CurrentUser, remedy: string): CurrentUser {
  if (!user.guest) return user;
  throw new ValidationError(`${GUEST_SESSION_EXPLANATION} ${remedy}`);
}
