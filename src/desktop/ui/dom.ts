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
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
