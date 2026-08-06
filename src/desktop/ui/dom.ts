/**
 * Escapes text for safe interpolation into an `innerHTML` template string.
 *
 * This is the ONE escaper used at every interpolation site in this UI, in
 * BOTH a text-node context (`<p>${escapeHtml(x)}</p>`) and an
 * attribute-value context (`value="${escapeHtml(x)}"`, choose.ts's
 * collection uuid and filter query). Escaping the full set (&, <, >, ", ')
 * unconditionally -- rather than offering a second, attribute-specific
 * function that call sites have to remember to reach for -- is deliberate:
 * a prior version escaped only &, < and > (correct for a text node, but not
 * an attribute), and that gap was exactly what let a collection whose uuid
 * was `evil" onmouseover="window.__pwned=8" data-x="` render a real DOM
 * node carrying a live onmouseover attribute (demonstrated live; blocked
 * only by CSP refusing the inline handler, not by this function). Escaping
 * quotes is harmless in a text node -- `&quot;`/`&#39;` still render as a
 * literal quote character -- so one function safe for both contexts closes
 * the gap everywhere at once instead of asking every future call site to
 * pick the right one of two similarly named functions.
 *
 * Implemented as plain string replacement rather than the DOM's own
 * text-node serializer (`div.textContent = s; return div.innerHTML`, the
 * previous implementation) so it can be unit tested under plain Node/vitest
 * -- this repo deliberately has no jsdom. `&` is replaced first so escaping
 * the other four characters' entity references does not itself get
 * re-escaped.
 */
/**
 * Preserve a text input's focus and caret across a re-render.
 *
 * Every screen here renders by replacing `innerHTML`, which destroys and
 * recreates its inputs. Any input whose `input` event triggers a re-render
 * therefore loses focus on every keystroke, so only the first character
 * arrives and the operator has to click back into the box for the next one.
 * Worse, a screen that *does* call `focus()` afterwards without restoring the
 * caret leaves it at position 0, and the text comes out reversed --
 * "title" typed as "eltit". Both were live: the Add-column search typed
 * backwards, and the Confirm screen's item-count box, which is the gate on
 * publishing to a collection with no review queue, dropped focus each time.
 *
 * Call before assigning `innerHTML`; call the returned function after.
 *
 * `focusWhenNew` is for a control that should take focus the first time it
 * appears, such as a search box in a dialog that has just opened.
 *
 * Not unit tested: this is DOM behaviour and the project has no jsdom. It was
 * verified by hand in the running app, which is the only place it can fail.
 */
export function keepCaret(
  root: HTMLElement,
  selector: string,
  options: { focusWhenNew?: boolean } = {},
): () => void {
  const previous = root.querySelector<HTMLInputElement>(selector);
  const hadFocus = previous !== null && root.ownerDocument.activeElement === previous;
  const caret = hadFocus ? previous.selectionStart : null;

  return () => {
    if (!hadFocus && options.focusWhenNew !== true) return;
    const next = root.querySelector<HTMLInputElement>(selector);
    if (next === null) return;
    next.focus();
    const position = caret ?? next.value.length;
    next.setSelectionRange(position, position);
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
