import type { InstanceChoice } from '../../ipc.js';
import { escapeHtml } from '../dom.js';
import { setupNotice } from '../setupNotice.js';

export interface SetupProps {
  /** Sites the operator has already added. Empty on a fresh install. */
  instances: InstanceChoice[];
  /** The saved instance being edited, or '' for a site not added yet. */
  instanceId: string;
  /** Whether credentials from an older version were found and discarded. */
  credentialsDropped: boolean;
  error: string | null;
  saving: boolean;
  onInstanceChange(id: string): void;
  onSave(
    instance: { label: string; baseUrl: string },
    settings: { clientId: string; clientSecret: string; redirectUri: string },
  ): void;
}

/**
 * Credential-entry screen, scoped to ONE site at a time (see secrets.ts: each
 * openEQUELLA site registers its own OAuth client, so there is no single
 * "the" client ID/secret). Reached on first run -- when the operator has
 * added no site at all -- or from Sign-in's "Add credentials" prompt for
 * whichever site turned out to have none.
 *
 * The address is typed here rather than picked from a list the app ships
 * with: this tool no longer knows any institution's addresses (ipc.ts). The
 * dropdown lists only what this operator has already added, plus the option
 * to add another.
 */
export function renderSetup(root: HTMLElement, props: SetupProps): void {
  const selected = props.instances.find((i) => i.id === props.instanceId);
  const label = selected?.label ?? '';
  const baseUrl = selected?.baseUrl ?? '';
  // Sensible starting point for a field non-technical staff cannot fill in
  // from nothing: the site's own address. Pre-filled into the form, where the
  // operator can see and correct it before saving -- never substituted behind
  // their back at sign-in time, which is how this value got hard-coded wrong
  // twice (see secrets.ts's Settings.redirectUri).
  const defaultRedirectUri = baseUrl;

  const options = [
    ...props.instances.map(
      (i) =>
        `<option value="${escapeHtml(i.id)}"${i.id === props.instanceId ? ' selected' : ''}>${escapeHtml(i.label)}</option>`,
    ),
    `<option value=""${props.instanceId === '' ? ' selected' : ''}>Add another site…</option>`,
  ].join('');

  const forWhat = selected ? escapeHtml(selected.label) : 'this site';

  root.innerHTML = `
    <section class="screen">
      <h1>Set up the Bulk Uploader</h1>
      ${setupNotice(props.credentialsDropped)}
      <p>
        Enter the address of your openEQUELLA site, and the
        <strong>client ID</strong> and <strong>client secret</strong> your
        administrator gave you. They are <strong>not included with this
        program</strong> &mdash; they are delivered to you separately, and are
        specific to your department.
      </p>
      <p>
        Once saved, they are stored <strong>encrypted for this Windows user
        only</strong>, using Windows' own credential protection. No one else
        who logs into this computer can read them, and they never leave this
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
          value="${escapeHtml(baseUrl)}"
        />

        <label for="setup-label">A name for it &mdash; whatever you call it, e.g. Production or Test</label>
        <input
          id="setup-label"
          name="label"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(label)}"
        />

        <label for="setup-client-id">Client ID (${forWhat})</label>
        <input id="setup-client-id" name="clientId" type="text" autocomplete="off" spellcheck="false" />

        <label for="setup-client-secret">Client secret (${forWhat})</label>
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
            ${props.saving ? 'Saving…' : 'Save credentials'}
          </button>
        </div>
      </form>
    </section>
  `;

  root.querySelector<HTMLSelectElement>('#setup-instance')?.addEventListener('change', (e) => {
    props.onInstanceChange((e.target as HTMLSelectElement).value);
  });

  const addressEl = root.querySelector<HTMLInputElement>('#setup-base-url');
  const redirectEl = root.querySelector<HTMLInputElement>('#setup-redirect-uri');
  // Keep the redirect URL following the address until the operator edits it
  // themselves. Deliberately NOT a re-render: this screen renders by replacing
  // innerHTML, which would destroy the field being typed into (see
  // ui/dom.ts#keepCaret). Writing the sibling field's value directly leaves
  // the caret alone, and what gets saved is exactly what is on screen.
  if (addressEl && redirectEl) {
    addressEl.addEventListener('input', () => {
      if (redirectEl.dataset.touched === 'true') return;
      redirectEl.value = addressEl.value.trim().replace(/\/+$/, '');
    });
    redirectEl.addEventListener('input', () => {
      redirectEl.dataset.touched = 'true';
    });
  }

  const form = root.querySelector<HTMLFormElement>('#setup-form');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = (id: string) => root.querySelector<HTMLInputElement>(id)?.value ?? '';
    props.onSave(
      { label: value('#setup-label').trim(), baseUrl: value('#setup-base-url').trim() },
      {
        clientId: value('#setup-client-id').trim(),
        clientSecret: value('#setup-client-secret'),
        redirectUri: value('#setup-redirect-uri').trim(),
      },
    );
  });
}
