import { escapeHtml } from '../dom.js';

export interface SetupProps {
  error: string | null;
  saving: boolean;
  onSave(clientId: string, clientSecret: string): void;
}

/**
 * First-run screen. Collects the client ID and secret the administrator
 * delivers out of band (never bundled with the app -- see secrets.ts) and
 * explains, in plain language, what happens to them once saved.
 */
export function renderSetup(root: HTMLElement, props: SetupProps): void {
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
      <form id="setup-form" novalidate>
        <label for="setup-client-id">Client ID</label>
        <input id="setup-client-id" name="clientId" type="text" autocomplete="off" spellcheck="false" />

        <label for="setup-client-secret">Client secret</label>
        <input id="setup-client-secret" name="clientSecret" type="password" autocomplete="off" spellcheck="false" />

        ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}

        <div class="button-row">
          <button type="submit" ${props.saving ? 'disabled' : ''}>
            ${props.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  `;

  const form = root.querySelector<HTMLFormElement>('#setup-form');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const clientId = root.querySelector<HTMLInputElement>('#setup-client-id')?.value ?? '';
    const clientSecret = root.querySelector<HTMLInputElement>('#setup-client-secret')?.value ?? '';
    props.onSave(clientId.trim(), clientSecret);
  });
}
