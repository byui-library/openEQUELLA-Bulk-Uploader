import { describe, it, expect } from 'vitest';
import { bannerClass } from '../../../src/desktop/ui/banner.js';
import type { InstanceChoice } from '../../../src/desktop/ipc.js';

/**
 * A WARNING THAT FIRES ON EVERYTHING STOPS BEING A WARNING.
 *
 * The banner shouted in red for the one instance the app shipped with named
 * "production". Task 11 deleted that shipped list, and with nothing left to
 * say which site was live, the banner started shouting on EVERY configured
 * site -- so an operator seeing red on their test instance every day would not
 * see it on the real one. This tool creates items with no undo, into a
 * collection with no moderation workflow, so the cue is load-bearing.
 *
 * The flag it reads is per-instance, set on Setup, and defaults to true (see
 * secrets.ts): a site is assumed live until the operator says otherwise, so the
 * failure direction stays safe while the signal stays recoverable.
 */
const instance = (over: Partial<InstanceChoice> = {}): InstanceChoice => ({
  id: 'https://oeq.example.edu',
  label: 'Live',
  baseUrl: 'https://oeq.example.edu',
  authMode: 'password',
  attachmentUuidPath: '',
  live: true,
  schemaUuid: '',
  ...over,
});

describe('the instance banner', () => {
  it('is loud for a live site', () => {
    expect(bannerClass(instance({ live: true }))).toContain('banner--production');
  });

  /**
   * The half that was missing. Without it every site got the loud treatment,
   * which is the same as no site getting it.
   */
  it('is quiet for a site the operator marked not live', () => {
    const cls = bannerClass(instance({ live: false, label: 'Sandbox' }));
    expect(cls).toContain('banner--test');
    expect(cls).not.toContain('banner--production');
  });

  // Nothing selected is nothing to be warned about.
  it('is quiet when no site is selected', () => {
    expect(bannerClass(null)).toContain('banner--test');
    expect(bannerClass(null)).not.toContain('banner--production');
  });

  /**
   * The direction to be wrong in. An instance that arrives without the flag --
   * a store written before it existed -- is read as live by secrets.ts, and a
   * site the operator has said nothing about is live here too. Being warned
   * about a sandbox is a nuisance; not being warned about production is an
   * unrecoverable batch.
   */
  it('treats an instance that says nothing about being live as live', () => {
    // Exactly the shape an entry written before the flag existed has: the
    // property is ABSENT, not false. secrets.ts's parse fills it in, but the
    // banner must not depend on that having happened to be safe.
    const legacy = { id: 'x', label: 'x', baseUrl: 'https://x.edu' } as unknown as InstanceChoice;
    expect(bannerClass(legacy)).toContain('banner--production');
    expect(bannerClass(legacy)).not.toContain('banner--test');
  });
});
