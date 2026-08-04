import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../../src/desktop/ui/dom.js';

/**
 * escapeHtml is the ONE escaper used at every template interpolation in
 * this UI -- both text-node context (`<p>${escapeHtml(x)}</p>`) and
 * attribute-value context (`value="${escapeHtml(x)}"`, choose.ts). It
 * previously escaped only &, < and > (correct for a text node, but not an
 * attribute), which allowed attribute breakout: demonstrated live, a
 * collection whose uuid was `evil" onmouseover="window.__pwned=8"
 * data-x="` rendered a real DOM node carrying a live onmouseover attribute,
 * with the visible option text desynced from its value. Blocked only by
 * CSP refusing the inline handler -- the escaper itself was broken.
 */
describe('escapeHtml', () => {
  it('escapes double quotes', () => {
    expect(escapeHtml('"')).toBe('&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes ampersands, angle brackets and quotes together, in an order that does not double-escape', () => {
    expect(escapeHtml(`<b class="x">&'</b>`)).toBe('&lt;b class=&quot;x&quot;&gt;&amp;&#39;&lt;/b&gt;');
  });

  it('neutralises the live attribute-breakout payload', () => {
    const payload = 'evil" onmouseover="window.__pwned=8" data-x="';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('evil&quot; onmouseover=&quot;window.__pwned=8&quot; data-x=&quot;');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeHtml('Sample Collection')).toBe('Sample Collection');
  });

  it('handles an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});
