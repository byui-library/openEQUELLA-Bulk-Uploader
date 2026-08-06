import type { ItemState } from '../../../core/types.js';
import { canUpload } from '../confirm.js';
import { escapeHtml, keepCaret } from '../dom.js';

export interface ConfirmProps {
  instanceLabel: string;
  collectionName: string;
  itemCount: number;
  itemState: ItemState;
  typedCount: string;
  uploading: boolean;
  error: string | null;
  onItemStateChange(s: ItemState): void;
  onTypedCountChange(v: string): void;
  onUpload(): void;
  onBack(): void;
}

/**
 * The most dangerous control in the app. Draft is selected by default and
 * needs nothing further; switching to Published reveals a panel that states
 * plainly this collection has no moderation workflow and requires TYPING the
 * item count before Upload enables (spec: "A dialog with an OK button is not
 * a safeguard; people click through those." -- so there is deliberately no
 * `window.confirm` anywhere in this flow). See ui/confirm.ts#canUpload for
 * the exact gate, unit tested against a non-matching count, a non-numeric
 * entry, and whitespace.
 */
export function renderConfirm(root: HTMLElement, props: ConfirmProps): void {
  const publishPanel =
    props.itemState === 'published'
      ? `
      <div class="danger-panel" role="alert">
        <p>
          <strong>This collection has no moderation workflow.</strong>
          Items published from here become visible to everyone immediately
          &mdash; there is no review step and no way to un-publish from this
          app.
        </p>
        <label for="confirm-typed-count">
          Type <strong>${props.itemCount}</strong> to confirm you want to publish
          ${props.itemCount} item(s):
        </label>
        <input
          id="confirm-typed-count"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(props.typedCount)}"
        />
      </div>`
      : '';

  const enabled = canUpload(props.itemState, props.itemCount, props.typedCount) && !props.uploading;

  const restoreCaret = keepCaret(root, '#confirm-typed-count');

  root.innerHTML = `
    <section class="screen">
      <h1>Confirm</h1>

      <dl class="confirm-summary">
        <dt>Instance</dt><dd>${escapeHtml(props.instanceLabel)}</dd>
        <dt>Collection</dt><dd>${escapeHtml(props.collectionName)}</dd>
        <dt>Items to create</dt><dd>${props.itemCount}</dd>
      </dl>

      <fieldset>
        <legend>Item state</legend>
        <label class="radio-label">
          <input type="radio" name="item-state" value="draft" ${props.itemState === 'draft' ? 'checked' : ''} />
          Draft (recommended) &mdash; created but not visible until someone submits it in openEQUELLA.
        </label>
        <label class="radio-label">
          <input type="radio" name="item-state" value="published" ${props.itemState === 'published' ? 'checked' : ''} />
          Published &mdash; visible immediately, no review step.
        </label>
      </fieldset>

      ${publishPanel}

      ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}

      <div class="button-row">
        <button id="confirm-back-btn" type="button" class="secondary">Back</button>
        <button id="confirm-upload-btn" type="button" ${enabled ? '' : 'disabled'}>
          ${props.uploading ? 'Starting…' : 'Upload'}
        </button>
      </div>
    </section>
  `;

  root.querySelectorAll<HTMLInputElement>('input[name="item-state"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (el.checked) props.onItemStateChange(el.value as ItemState);
    });
  });
  root.querySelector<HTMLInputElement>('#confirm-typed-count')?.addEventListener('input', (e) => {
    props.onTypedCountChange((e.target as HTMLInputElement).value);
  });
  // Typing here re-renders the screen, which recreated this input and dropped
  // focus after every character -- so the count could only be entered one digit
  // per click. This is the gate on publishing to a collection with no review
  // queue, and a gate that is painful to operate is one people work around.
  restoreCaret();
  root.querySelector<HTMLButtonElement>('#confirm-back-btn')?.addEventListener('click', () => props.onBack());
  root.querySelector<HTMLButtonElement>('#confirm-upload-btn')?.addEventListener('click', () => props.onUpload());
}
