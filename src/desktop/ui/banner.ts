import { UI_INSTANCES } from './instances.js';

/**
 * Persistent instance banner, rendered on every screen.
 *
 * Why this exists at all: the collection UUID is byte-identical on test and
 * production (see ipc.ts), so this banner is the ONLY durable cue telling
 * the user which one they are pointed at. Production must be visually
 * unmistakable -- the `banner--production` class (styles.css) makes it solid
 * red, not a subtle badge.
 */
export function renderBanner(root: HTMLElement, instanceId: string): void {
  const inst = UI_INSTANCES.find((i) => i.id === instanceId);
  const label = inst?.label ?? instanceId;
  const baseUrl = inst?.baseUrl ?? '';
  root.innerHTML = '';

  const bar = document.createElement('div');
  bar.className = `banner ${instanceId === 'production' ? 'banner--production' : 'banner--test'}`;
  bar.setAttribute('role', 'status');

  const strong = document.createElement('strong');
  strong.textContent = instanceId === 'production' ? 'PRODUCTION' : label.toUpperCase();
  bar.append(strong);

  const detail = document.createElement('span');
  detail.className = 'banner__detail';
  detail.textContent = baseUrl ? ` — ${baseUrl}` : '';
  bar.append(detail);

  root.append(bar);
}
