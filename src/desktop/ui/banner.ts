import type { InstanceChoice } from '../ipc.js';

/**
 * Persistent instance banner, rendered on every screen.
 *
 * Why this exists at all: a collection UUID can be byte-identical on two
 * sites, so this banner is the ONLY durable cue telling the operator which
 * one they are pointed at. This tool creates items with no undo, into
 * collections that may have no moderation workflow, so the cue is
 * load-bearing.
 *
 * IT IS LOUD ONLY FOR A LIVE SITE. It used to shout for the one instance the
 * app shipped with named "production"; when that shipped list was deleted,
 * nothing told the app which site was live and it shouted red on EVERY
 * configured site instead. A warning that fires on everything stops being a
 * warning -- an operator seeing red on their test instance daily will not see
 * it on the real one.
 *
 * So it reads `instance.live`, a per-instance flag the operator sets on Setup,
 * which DEFAULTS TO TRUE (secrets.ts). The app still never guesses: a site is
 * assumed live until somebody says otherwise, so the failure direction stays
 * safe while the signal stays recoverable. Nothing selected is quiet, because
 * there is nothing to be warned about.
 */
/**
 * The banner's class list -- the loud treatment or the quiet one.
 *
 * Pulled out as a pure function, and not merely for tidiness: this project has
 * no jsdom, so `renderBanner` below cannot be exercised by a test at all, and
 * the rule that decides loud-or-quiet is the whole point of the banner. Left
 * inline it would be untested, which is exactly how it came to shout on every
 * site without anything noticing.
 *
 * `!== false`, not a truthiness test: only an EXPLICIT "not live" quietens
 * this. An instance whose flag is somehow absent -- an entry from a store
 * written before the flag existed that reached here without going through
 * secrets.ts's parse -- is treated as live, which is the same default the
 * store applies and the only safe direction to be wrong in. Nothing selected
 * is quiet, because there is nothing to be warned about.
 */
export function bannerClass(instance: InstanceChoice | null): string {
  return `banner ${instance !== null && instance.live !== false ? 'banner--production' : 'banner--test'}`;
}

export function renderBanner(root: HTMLElement, instance: InstanceChoice | null): void {
  root.innerHTML = '';

  const bar = document.createElement('div');
  bar.className = bannerClass(instance);
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
