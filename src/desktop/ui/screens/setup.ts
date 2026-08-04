import { escapeHtml } from '../dom.js';
import { UI_INSTANCES } from '../instances.js';

export interface SetupProps {
  instanceId: string;
  error: string | null;
  saving: boolean;
  onInstanceChange(id: string): void;
  onSave(clientId: string, clientSecret: string, redirectUri: string): void;
}

/**
 * Credential-entry screen, scoped to ONE instance at a time (see
 * secrets.ts: production and test each register their own OAuth client, so
 * there is no single "the" client ID/secret anymore). Reached either on
 * first run (nothing configured for any instance yet -- defaults to
 * Production, since most operators only ever touch that one, per the
 * instance dropdown below) or from Sign-in's "Add credentials" prompt for
 * whichever instance turned out to have none.
 *
 * The dropdown exists mainly for the rare operator who also has Test
 * credentials to enter; it must never be presented as though picking Test
 * were expected or required.
 */
export function renderSetup(root: HTMLElement, props: SetupProps): void {
  const inst = UI_INSTANCES.find((i) => i.id === props.instanceId);
  const label = inst?.label ?? props.instanceId;
  // Sensible default for a field non-technical staff cannot be expected to
  // fill in from nothing: the instance's own base url, with no trailing
  // slash -- matches both of the operator's new dedicated OAuth clients.
  // Always editable; see the label text below for why it must match exactly.
  const defaultRedirectUri = inst?.baseUrl ?? '';

  const options = UI_INSTANCES.map(
    (i) => `<option value="${i.id}"${i.id === props.instanceId ? ' selected' : ''}>${escapeHtml(i.label)}</option>`,
  ).join('');

  root.innerHTML = `
    <section class="screen">
      <h1>Set up the Bulk Uploader</h1>
      <p>
        Before you can sign in, enter the <strong>client ID</strong> and
        <strong>client secret</strong> your administrator gave you. They are
        <strong>not included with this program</strong> &mdash; they are
        delivered to you separately, and are specific to your department.
      </p>
      <p>
        Once saved, they are stored <strong>encrypted for this Windows user
        only</strong>, using Windows' own credential protection. No one else
        who logs into this computer can read them, and they never leave this
        machine except to sign in to openEQUELLA.
      </p>

      <label for="setup-instance">These credentials are for</label>
      <select id="setup-instance">${options}</select>
      <p class="hint">
        Most people only ever need <strong>Production</strong>. Only pick
        Test if your administrator specifically gave you Test credentials.
      </p>

      <form id="setup-form" novalidate>
        <label for="setup-client-id">Client ID (${escapeHtml(label)})</label>
        <input id="setup-client-id" name="clientId" type="text" autocomplete="off" spellcheck="false" />

        <label for="setup-client-secret">Client secret (${escapeHtml(label)})</label>
        <input id="setup-client-secret" name="clientSecret" type="password" autocomplete="off" spellcheck="false" />

        <label for="setup-redirect-uri">Redirect URL &mdash; must match exactly what is registered on the OAuth client, including or excluding a trailing slash.</label>
        <input
          id="setup-redirect-uri"
          name="redirectUri"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(defaultRedirectUri)}"
        />

        ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}

        <div class="button-row">
          <button type="submit" ${props.saving ? 'disabled' : ''}>
            ${props.saving ? 'Saving…' : `Save ${escapeHtml(label)} credentials`}
          </button>
        </div>
      </form>
    </section>
  `;

  root.querySelector<HTMLSelectElement>('#setup-instance')?.addEventListener('change', (e) => {
    props.onInstanceChange((e.target as HTMLSelectElement).value);
  });

  const form = root.querySelector<HTMLFormElement>('#setup-form');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const clientId = root.querySelector<HTMLInputElement>('#setup-client-id')?.value ?? '';
    const clientSecret = root.querySelector<HTMLInputElement>('#setup-client-secret')?.value ?? '';
    const redirectUri = root.querySelector<HTMLInputElement>('#setup-redirect-uri')?.value ?? '';
    props.onSave(clientId.trim(), clientSecret, redirectUri.trim());
  });
}
