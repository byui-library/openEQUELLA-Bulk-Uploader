/**
 * The one sentence the clean break of 2026-08-12 owes the operator.
 *
 * Credentials stored by v1.0.0 were keyed by the names of two instances this
 * tool no longer ships with, so they cannot be rekeyed and are discarded
 * (secrets.ts). Without this notice the operator opens the app they have used
 * for months and finds an empty Setup form: indistinguishable from a broken
 * install, and "just retype what you had" would be wrong advice anyway,
 * because the client secret was reset at the same time.
 *
 * Returns markup, not a full screen, so it can sit at the top of Setup; and
 * the empty string when there is nothing to explain, so a fresh install is
 * not told about a version it never ran.
 *
 * The sentence is kept on one source line on purpose: wrapping it would put a
 * newline inside it, and both this project's tests and anyone grepping for
 * the wording an operator reported would then miss it.
 */
export function setupNotice(credentialsDropped: boolean): string {
  if (!credentialsDropped) return '';
  const message =
    'This version stores credentials differently, and the client secret has been reset. Ask your administrator for the current client ID and secret.';
  return `
      <p class="notice" role="status">${message}</p>`;
}
