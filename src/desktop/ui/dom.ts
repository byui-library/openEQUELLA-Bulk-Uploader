/**
 * Escapes text for safe interpolation into an `innerHTML` template string.
 * Every value that reaches a template in this UI that did not originate as a
 * fixed string literal (collection names, file paths, error messages, the
 * signed-in user's name) goes through this first.
 */
export function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
