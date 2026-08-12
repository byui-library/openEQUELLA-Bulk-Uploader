import type { InstanceChoice } from '../ipc.js';

/**
 * Persistent instance banner, rendered on every screen.
 *
 * Why this exists at all: a collection UUID can be byte-identical on two
 * sites, so this banner is the ONLY durable cue telling the operator which
 * one they are pointed at.
 *
 * It used to shout PRODUCTION in red for the one instance the app shipped
 * with by that name, and show test in a quieter style. The app no longer
 * ships knowing any site (ipc.ts), and nothing an operator types tells it
 * which of their sites is the live one -- so every configured site now gets
 * the loud treatment, carrying its own name and address. Guessing which is
 * safe would be the wrong direction to be wrong in; the address is what the
 * operator can actually check.
 */
export function renderBanner(root: HTMLElement, instance: InstanceChoice | null): void {
  root.innerHTML = '';

  const bar = document.createElement('div');
  bar.className = `banner ${instance ? 'banner--production' : 'banner--test'}`;
  bar.setAttribute('role', 'status');

  const strong = document.createElement('strong');
  strong.textContent = instance ? instance.label.toUpperCase() : 'NO SITE SELECTED';
  bar.append(strong);

  const detail = document.createElement('span');
  detail.className = 'banner__detail';
  detail.textContent = instance?.baseUrl ? ` — ${instance.baseUrl}` : '';
  bar.append(detail);

  root.append(bar);
}
