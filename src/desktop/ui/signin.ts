import type { CurrentUser } from '../../core/client.js';

export type SigninMode = 'missing-credentials' | 'needs-signin' | 'signed-in';

/**
 * What the Sign-in screen should show for the currently selected instance.
 *
 * Credentials are now per instance (see secrets.ts): production and test
 * each register their own OAuth client, so an instance with nothing saved
 * must never be allowed to attempt a sign-in -- it would only reach
 * openEQUELLA and fail with a client_id/redirect_uri mismatch (the bug this
 * whole change fixes). Instead the screen offers to add credentials for
 * that instance right there, rather than failing at sign-in.
 *
 * 'missing-credentials' takes priority over `user`: app.ts clears `user` on
 * every instance change, but this function does not depend on that -- a
 * stale signed-in user for a PREVIOUSLY selected instance must never be
 * displayed as if it belonged to an instance that, in fact, has no
 * credentials saved at all.
 */
export function signinMode(instanceHasSettings: boolean, user: CurrentUser | null): SigninMode {
  if (!instanceHasSettings) return 'missing-credentials';
  return user ? 'signed-in' : 'needs-signin';
}
