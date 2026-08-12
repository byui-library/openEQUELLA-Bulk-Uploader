import type { InstanceChoice } from '../../ipc.js';
// `import type`: secrets.ts reaches `node:fs`, and this module is rendered in
// the sandboxed renderer. A type-only import is erased at compile time and
// never becomes a runtime require -- see tests/desktop/rendererPurity.test.ts.
import type { Settings, SettingsAuthMode } from '../../secrets.js';
import { escapeHtml, keepCaret } from '../dom.js';
import { setupNotice } from '../setupNotice.js';

/**
 * Everything the operator can type on this screen, held by the app rather
 * than by the DOM.
 *
 * CONTROLLED, and it has to be: choosing a sign-in method re-renders, and a
 * screen that renders by replacing `innerHTML` destroys every input it has
 * when it does. With the values in the DOM only, switching to Advanced would
 * silently erase the address the operator had just typed. Held here, the
 * re-render puts every field back exactly as it was -- and `keepCaret` (see
 * `renderSetup`) puts the caret back with it.
 */
export interface SetupFields {
  baseUrl: string;
  label: string;
  authMode: SettingsAuthMode;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  username: string;
  password: string;
}

/**
 * The typed fields, as opposed to the sign-in method. Kept apart from
 * `authMode` so `onFieldChange` cannot be handed a mode as a bare string and
 * have to re-validate it: the mode has its own callback and its own type.
 */
export type SetupTextField = Exclude<keyof SetupFields, 'authMode'>;

export interface SetupProps {
  /** Sites the operator has already added. Empty on a fresh install. */
  instances: InstanceChoice[];
  /** The saved instance being edited, or '' for a site not added yet. */
  instanceId: string;
  /** Whether credentials from an older version were found and discarded. */
  credentialsDropped: boolean;
  fields: SetupFields;
  /**
   * The account already stored for this instance, or null when there is none.
   *
   * The USERNAME only -- the password never comes back out of the main
   * process (see ipc.ts's `getPassword`). It is all this screen needs: a name
   * to show beside "Signed in as", and the fact that there is something to
   * forget.
   */
  storedUsername: string | null;
  error: string | null;
  saving: boolean;
  onInstanceChange(id: string): void;
  onFieldChange(field: SetupTextField, value: string): void;
  onAuthModeChange(mode: SettingsAuthMode): void;
  onForgetPassword(): void;
  onSave(instance: { label: string; baseUrl: string }, settings: Settings): void;
}

/**
 * Every text input on this screen, so the caret survives the re-render that
 * every keystroke causes. Any input added here must be added to this list --
 * without it the field loses focus after one character, or types backwards
 * (ui/dom.ts#keepCaret; both shipped unnoticed for months).
 */
export const TEXT_INPUTS = [
  '#setup-base-url',
  '#setup-label',
  '#setup-username',
  '#setup-password',
  '#setup-client-id',
  '#setup-client-secret',
  '#setup-redirect-uri',
] as const;

/**
 * The sign-in half of the screen.
 *
 * Username and password comes FIRST, and is the default, because it is what
 * an institution can use on the day it installs this tool: an ordinary
 * openEQUELLA account, with nothing to request from an administrator. OAuth
 * lives behind an Advanced disclosure for the sites that need it -- BYU-Idaho
 * among them, where sign-in goes through SSO and a client ID and secret are
 * the only way in.
 *
 * Which one is used is an EXPLICIT choice, carried by `fields.authMode` and
 * stored as a discriminator (secrets.ts). It is never inferred from which
 * boxes happen to be filled in: a half-typed form would then quietly change
 * how the operator signs in.
 */
function authSection(props: SetupProps, forWhat: string): string {
  const f = props.fields;
  const account =
    props.storedUsername !== null
      ? `
        <div class="signed-in-card">
          <p>Signed in as <strong>${escapeHtml(props.storedUsername)}</strong></p>
          <div class="button-row">
            <button id="setup-forget-password" type="button" class="secondary">Forget this password</button>
          </div>
          <p class="note">
            Stored encrypted for your Windows account only.
            Another user on this PC cannot read it.
          </p>
        </div>`
      : `
        <label for="setup-username">Username (${forWhat})</label>
        <input
          id="setup-username"
          name="username"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.username)}"
        />

        <label for="setup-password">Password (${forWhat})</label>
        <input
          id="setup-password"
          name="password"
          type="password"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.password)}"
        />`;

  return `
      <fieldset class="auth-method">
        <legend>How you sign in</legend>

        <label class="radio-label" for="setup-auth-password">
          <input
            id="setup-auth-password"
            name="setup-auth-mode"
            type="radio"
            value="password"
            ${f.authMode === 'password' ? 'checked' : ''}
          />
          <span>Username and password</span>
        </label>
        ${f.authMode === 'password' ? account : ''}

        <details id="setup-advanced" ${f.authMode === 'code' ? 'open' : ''}>
          <summary>Advanced: OAuth client credentials</summary>
          <p class="hint">
            For sites behind single sign-on, where an ordinary password will not
            work. Your administrator issues the client ID and secret; they are
            <strong>not included with this program</strong>.
          </p>

          <label class="radio-label" for="setup-auth-code">
            <input
              id="setup-auth-code"
              name="setup-auth-mode"
              type="radio"
              value="code"
              ${f.authMode === 'code' ? 'checked' : ''}
            />
            <span>Use OAuth client credentials</span>
          </label>

          <label for="setup-client-id">Client ID (${forWhat})</label>
          <input
            id="setup-client-id"
            name="clientId"
            type="text"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(f.clientId)}"
          />

          <label for="setup-client-secret">Client secret (${forWhat})</label>
          <input
            id="setup-client-secret"
            name="clientSecret"
            type="password"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(f.clientSecret)}"
          />

          <label for="setup-redirect-uri">Redirect URL &mdash; must match exactly what is registered on the OAuth client, including or excluding a trailing slash.</label>
          <input
            id="setup-redirect-uri"
            name="redirectUri"
            type="text"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(f.redirectUri)}"
          />
        </details>
      </fieldset>`;
}

/**
 * The whole screen as markup, separated from `renderSetup` so it can be
 * asserted against as a string -- this project has no jsdom, and the existing
 * screen tests (ui/duplicates.ts and its test) read the markup a renderer
 * produces rather than a DOM it builds.
 */
export function setupMarkup(props: SetupProps): string {
  const selected = props.instances.find((i) => i.id === props.instanceId);

  const options = [
    ...props.instances.map(
      (i) =>
        `<option value="${escapeHtml(i.id)}"${i.id === props.instanceId ? ' selected' : ''}>${escapeHtml(i.label)}</option>`,
    ),
    `<option value=""${props.instanceId === '' ? ' selected' : ''}>Add another site…</option>`,
  ].join('');

  const forWhat = selected ? escapeHtml(selected.label) : 'this site';

  return `
    <section class="screen">
      <h1>Set up the Bulk Uploader</h1>
      ${setupNotice(props.credentialsDropped)}
      <p>
        Enter the address of your openEQUELLA site and how you sign in to it.
        Most institutions sign in with an ordinary openEQUELLA
        <strong>username and password</strong> &mdash; the same one you use on
        the site itself.
      </p>
      <p>
        Once saved, this is stored <strong>encrypted for this Windows user
        only</strong>, using Windows' own credential protection. No one else
        who logs into this computer can read it, and it never leaves this
        machine except to sign in to openEQUELLA.
      </p>

      ${
        props.instances.length > 0
          ? `<label for="setup-instance">These credentials are for</label>
      <select id="setup-instance">${options}</select>`
          : ''
      }

      <form id="setup-form" novalidate>
        <label for="setup-base-url">Site address &mdash; for example https://oeq.yourschool.edu</label>
        <input
          id="setup-base-url"
          name="baseUrl"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(props.fields.baseUrl)}"
        />

        <label for="setup-label">A name for it &mdash; whatever you call it, e.g. Production or Test</label>
        <input
          id="setup-label"
          name="label"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(props.fields.label)}"
        />

        ${authSection(props, forWhat)}

        ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}

        <div class="button-row">
          <button type="submit" ${props.saving ? 'disabled' : ''}>
            ${props.saving ? 'Saving…' : 'Save credentials'}
          </button>
        </div>
      </form>
    </section>
  `;
}

/**
 * The `Settings` this screen would save, assembled from what it actually
 * rendered.
 *
 * In password mode with an account already stored, the form shows "Signed in
 * as ..." and no password box at all, so it submits the stored username and an
 * EMPTY password -- which secrets.ts reads as "leave the stored password
 * alone". That is what lets the operator rename a site without being made to
 * type their password again, and it is why the only way to remove a password
 * is the Forget button.
 */
export function settingsFrom(props: SetupProps): Settings {
  const f = props.fields;
  if (f.authMode === 'password') {
    return {
      authMode: 'password',
      username: props.storedUsername ?? f.username.trim(),
      password: props.storedUsername !== null ? '' : f.password,
    };
  }
  return {
    authMode: 'code',
    clientId: f.clientId.trim(),
    clientSecret: f.clientSecret,
    redirectUri: f.redirectUri.trim(),
  };
}

/**
 * Credential-entry screen, scoped to ONE site at a time (see secrets.ts: each
 * openEQUELLA site has its own accounts and registers its own OAuth client, so
 * there is no single "the" credential). Reached on first run -- when the
 * operator has added no site at all -- or from Sign-in's "Add credentials"
 * prompt for whichever site turned out to have none.
 *
 * The address is typed here rather than picked from a list the app ships
 * with: this tool no longer knows any institution's addresses (ipc.ts). The
 * dropdown lists only what this operator has already added, plus the option
 * to add another.
 */
export function renderSetup(root: HTMLElement, props: SetupProps): void {
  // Every keystroke re-renders this screen (the fields are controlled -- see
  // SetupFields), which destroys and recreates the input being typed into.
  const restoreCaret = TEXT_INPUTS.map((selector) => keepCaret(root, selector));

  root.innerHTML = setupMarkup(props);

  for (const restore of restoreCaret) restore();

  root.querySelector<HTMLSelectElement>('#setup-instance')?.addEventListener('change', (e) => {
    props.onInstanceChange((e.target as HTMLSelectElement).value);
  });

  const field = (selector: string, name: SetupTextField): void => {
    root.querySelector<HTMLInputElement>(selector)?.addEventListener('input', (e) => {
      props.onFieldChange(name, (e.target as HTMLInputElement).value);
    });
  };
  field('#setup-base-url', 'baseUrl');
  field('#setup-label', 'label');
  field('#setup-username', 'username');
  field('#setup-password', 'password');
  field('#setup-client-id', 'clientId');
  field('#setup-client-secret', 'clientSecret');
  field('#setup-redirect-uri', 'redirectUri');

  for (const [selector, mode] of [
    ['#setup-auth-password', 'password'],
    ['#setup-auth-code', 'code'],
  ] as const) {
    root.querySelector<HTMLInputElement>(selector)?.addEventListener('change', () => {
      props.onAuthModeChange(mode);
    });
  }

  root
    .querySelector<HTMLButtonElement>('#setup-forget-password')
    ?.addEventListener('click', () => props.onForgetPassword());

  root.querySelector<HTMLFormElement>('#setup-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    props.onSave(
      { label: props.fields.label.trim(), baseUrl: props.fields.baseUrl.trim() },
      settingsFrom(props),
    );
  });
}
