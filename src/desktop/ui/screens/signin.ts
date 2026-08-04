import type { CurrentUser } from '../../../core/client.js';
import { UI_INSTANCES } from '../instances.js';
import { escapeHtml } from '../dom.js';

export interface SigninProps {
  instanceId: string;
  user: CurrentUser | null;
  checkingUser: boolean;
  signingIn: boolean;
  error: string | null;
  onInstanceChange(id: string): void;
  onSignIn(): void;
  onSignOut(): void;
  onContinue(): void;
  onResetSettings(): void;
}

/**
 * Sign-in screen. The instance dropdown drives the banner too -- changing it
 * here re-checks (via window.oeq.currentUser) whether a still-valid token
 * already exists for that instance, since a token minted for Test is refused
 * against Production and vice versa (core token-store behaviour, unchanged).
 */
export function renderSignin(root: HTMLElement, props: SigninProps): void {
  const options = UI_INSTANCES.map(
    (i) =>
      `<option value="${i.id}"${i.id === props.instanceId ? ' selected' : ''}>${escapeHtml(i.label)}</option>`,
  ).join('');

  const signedInBlock = props.user
    ? `
      <div class="signed-in-card">
        <p>
          Signed in as
          <strong>${escapeHtml(props.user.firstName)} ${escapeHtml(props.user.lastName)}</strong>
          (${escapeHtml(props.user.username)}).
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
        ${props.signingIn ? 'Opening sign-in window…' : 'Sign in'}
      </button>
      <p class="hint">
        This opens an openEQUELLA sign-in window. Sign in there and this
        screen will update automatically.
      </p>`;

  root.innerHTML = `
    <section class="screen">
      <h1>Sign in</h1>

      <label for="signin-instance">Instance</label>
      <select id="signin-instance">${options}</select>

      ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}
      ${props.checkingUser ? `<p class="muted">Checking for an existing sign-in…</p>` : ''}

      ${signedInBlock}

      <p class="reset-row">
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
    .querySelector<HTMLButtonElement>('#reset-settings-btn')
    ?.addEventListener('click', () => props.onResetSettings());
}
