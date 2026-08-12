import type { CurrentUser } from '../../../core/client.js';
import type { InstanceChoice } from '../../ipc.js';
// `import type`: secrets.ts reaches `node:fs` and this module runs in the
// sandboxed renderer. Erased at compile time; never a runtime require.
import type { SettingsAuthMode } from '../../secrets.js';
import { escapeHtml } from '../dom.js';
import { signinMode } from '../signin.js';

/**
 * What the Sign-in button is about to do, in the operator's words.
 *
 * MODE-AWARE because the old copy -- "This opens an openEQUELLA sign-in
 * window" -- is simply untrue in password mode, where the handler signs in
 * directly with the stored account and no browser window ever appears
 * (handlers.ts's signIn). An operator told to expect a window that never comes
 * has no way to tell a working sign-in from a broken one.
 *
 * Exported so it can be asserted on directly: the two modes must not say the
 * same thing, which is the failure being fixed.
 */
export function signinHint(authMode: SettingsAuthMode): string {
  return authMode === 'password'
    ? 'This signs in with the username and password saved for this site. ' +
        'No sign-in window opens.'
    : 'This opens an openEQUELLA sign-in window. Sign in there and this ' +
        'screen will update automatically.';
}

/** The button's own label, for the same reason: nothing is "opening" in password mode. */
export function signinBusyLabel(authMode: SettingsAuthMode): string {
  return authMode === 'password' ? 'Signing in…' : 'Opening sign-in window…';
}

export interface SigninProps {
  /** The sites the operator has added. Comes from the store, not from a shipped list. */
  instances: InstanceChoice[];
  instanceId: string;
  instanceHasSettings: boolean;
  user: CurrentUser | null;
  checkingUser: boolean;
  signingIn: boolean;
  error: string | null;
  onInstanceChange(id: string): void;
  onSignIn(): void;
  onSignOut(): void;
  onContinue(): void;
  onAddCredentials(): void;
  /**
   * Back to Setup for the SELECTED site, clearing nothing.
   *
   * Without it the per-site settings Setup now collects -- which collection's
   * schema to check against, where the attachment uuid is written, whether
   * this is a live site -- would be reachable only by "Change credentials…",
   * which wipes every saved site first. A setting an operator can only change
   * by destroying their credentials is a setting they will not change.
   */
  onSiteSettings(): void;
  onResetSettings(): void;
}

/**
 * Sign-in screen. The instance dropdown drives the banner too -- changing it
 * here re-checks (via window.oeq.currentUser) whether a still-valid token
 * already exists for that instance, since a token minted for one site is
 * refused by another (core token-store behaviour, unchanged).
 *
 * Credentials are per instance (secrets.ts), so switching the dropdown to a
 * site that has never been configured must never present a "Sign in" button
 * that can only fail -- see signinMode. Instead it offers to add credentials
 * for exactly that site, right here.
 */
export function renderSignin(root: HTMLElement, props: SigninProps): void {
  const options = props.instances
    .map(
      (i) =>
        `<option value="${escapeHtml(i.id)}"${i.id === props.instanceId ? ' selected' : ''}>${escapeHtml(i.label)}</option>`,
    )
    .join('');

  const selected = props.instances.find((i) => i.id === props.instanceId);
  const label = selected?.label ?? props.instanceId;
  const mode = signinMode(props.instanceHasSettings, props.user);
  // 'code' for a site not in the list at all: that is the flow that opens a
  // window, and promising a window that then appears is the harmless way to be
  // wrong. Every saved instance carries its real mode (ipc.ts).
  const authMode = selected?.authMode ?? 'code';

  const body =
    mode === 'missing-credentials'
      ? `
      <div class="signed-in-card">
        <p>No credentials are saved for <strong>${escapeHtml(label)}</strong> yet.</p>
        <div class="button-row">
          <button id="add-credentials-btn" type="button">Add credentials for ${escapeHtml(label)}</button>
        </div>
      </div>`
      : mode === 'signed-in'
        ? `
      <div class="signed-in-card">
        <p>
          Signed in as
          <strong>${escapeHtml(props.user!.firstName)} ${escapeHtml(props.user!.lastName)}</strong>
          (${escapeHtml(props.user!.username)}).
        </p>
        <p class="note">
          Every item created during this session will be owned by this
          person.
        </p>
        <div class="button-row">
          <button id="continue-btn" type="button">Continue</button>
          <button id="signout-btn" type="button" class="secondary">Sign out</button>
        </div>
      </div>`
        : `
      <button id="signin-btn" type="button" ${props.signingIn ? 'disabled' : ''}>
        ${props.signingIn ? escapeHtml(signinBusyLabel(authMode)) : 'Sign in'}
      </button>
      <p class="hint">${escapeHtml(signinHint(authMode))}</p>`;

  root.innerHTML = `
    <section class="screen">
      <h1>Sign in</h1>

      <label for="signin-instance">Instance</label>
      <select id="signin-instance">${options}</select>

      ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}
      ${props.checkingUser ? `<p class="muted">Checking for an existing sign-in…</p>` : ''}

      ${body}

      <p class="reset-row">
        <button id="site-settings-btn" type="button" class="link-button">Settings for ${escapeHtml(label)}…</button>
        <button id="reset-settings-btn" type="button" class="link-button">Change credentials…</button>
      </p>
    </section>
  `;

  root.querySelector<HTMLSelectElement>('#signin-instance')?.addEventListener('change', (e) => {
    props.onInstanceChange((e.target as HTMLSelectElement).value);
  });
  root.querySelector<HTMLButtonElement>('#signin-btn')?.addEventListener('click', () => props.onSignIn());
  root.querySelector<HTMLButtonElement>('#signout-btn')?.addEventListener('click', () => props.onSignOut());
  root.querySelector<HTMLButtonElement>('#continue-btn')?.addEventListener('click', () => props.onContinue());
  root
    .querySelector<HTMLButtonElement>('#add-credentials-btn')
    ?.addEventListener('click', () => props.onAddCredentials());
  root
    .querySelector<HTMLButtonElement>('#site-settings-btn')
    ?.addEventListener('click', () => props.onSiteSettings());
  root
    .querySelector<HTMLButtonElement>('#reset-settings-btn')
    ?.addEventListener('click', () => props.onResetSettings());
}
