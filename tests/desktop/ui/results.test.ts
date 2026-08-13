import { describe, it, expect } from 'vitest';
import { renderResults, type ResultsProps } from '../../../src/desktop/ui/screens/results.js';
import { FakeElement } from '../../helpers/fakeDom.js';

/**
 * The Done screen, asserted as the markup it renders and the handlers it wires
 * -- this project deliberately has no jsdom, so `tests/helpers/fakeDom.ts` is
 * the stand-in (see its own doc comment).
 *
 * IT WAS A DEAD END. "Upload another spreadsheet" went to Choose, there was a
 * link to the collection, and that was every exit it had. An operator who
 * finished a batch and then wanted to point the tool at another site, or check
 * a setting, had to close and reopen the app -- which is exactly the report
 * that produced Choose's own route back to Setup.
 */
const REPORT = {
  created: 3,
  failed: 0,
  skipped: 0,
  incomplete: 0,
  interrupted: 0,
  failures: [],
};

const props = (over: Partial<ResultsProps> = {}): ResultsProps => ({
  report: REPORT,
  interrupted: [],
  collectionUrl: 'https://library.example.test/items?collection=coll-1',
  collectionName: 'Faculty Content',
  instanceLabel: 'Library',
  retrying: false,
  error: null,
  onRetryFailed: () => {},
  onAnotherBatch: () => {},
  onSiteSettings: () => {},
  onSignOut: () => {},
  ...over,
});

function render(over: Partial<ResultsProps> = {}): {
  root: FakeElement;
  calls: { another: number; siteSettings: number; signOut: number };
} {
  const root = new FakeElement();
  const calls = { another: 0, siteSettings: 0, signOut: 0 };
  renderResults(
    root as unknown as HTMLElement,
    props({
      onAnotherBatch: () => (calls.another += 1),
      onSiteSettings: () => (calls.siteSettings += 1),
      onSignOut: () => (calls.signOut += 1),
      ...over,
    }),
  );
  return { root, calls };
}

describe('what Done already did', () => {
  it('still offers another spreadsheet, and still links the collection', () => {
    const { root, calls } = render();
    expect(root.has('#results-another-btn')).toBe(true);
    expect(root.has('#results-open-collection')).toBe(true);
    root.fire('#results-another-btn');
    expect(calls.another).toBe(1);
  });
});

/**
 * The same two site-level actions Choose carries, in the same place and the
 * same low-emphasis treatment. Results is post-run, so both are safe here:
 * there is no batch left to lose.
 */
describe('the routes off the Done screen', () => {
  it('offers site settings and sign-out, both naming the site', () => {
    const { root } = render();
    expect(root.has('#results-site-settings')).toBe(true);
    expect(root.has('#results-sign-out')).toBe(true);
    expect(root.innerHTML).toContain('Site settings for Library');
    expect(root.innerHTML).toContain('Sign out of Library');
  });

  it('calls onSiteSettings when the settings link is clicked, and nothing else', () => {
    const { root, calls } = render();
    root.fire('#results-site-settings');
    expect(calls).toEqual({ another: 0, siteSettings: 1, signOut: 0 });
  });

  it('calls onSignOut when the sign-out link is clicked, and nothing else', () => {
    const { root, calls } = render();
    root.fire('#results-sign-out');
    expect(calls).toEqual({ another: 0, siteSettings: 0, signOut: 1 });
  });

  /**
   * WORDING. The one thing an operator cannot see here is whether leaving
   * re-uploads anything, and the one thing they lose is this summary -- which
   * is the only place the collection link lives.
   */
  it('says the batch is finished, that nothing uploads again, and what leaving costs', () => {
    const { root } = render();
    expect(root.innerHTML).toMatch(/nothing is uploaded again/i);
    expect(root.innerHTML).toMatch(/sign-in screen/i);
    expect(root.innerHTML).toMatch(/different site/i);
    expect(root.innerHTML).toMatch(/summary is not kept/i);
  });

  // Below "Upload another spreadsheet", which is what most operators want, and
  // in the same low-emphasis treatment Choose and Sign-in use.
  it('puts both below the primary action as link-buttons', () => {
    const { root } = render();
    expect(root.innerHTML).toContain('class="link-button"');
    expect(root.innerHTML.indexOf('results-site-settings')).toBeGreaterThan(
      root.innerHTML.indexOf('results-another-btn'),
    );
    expect(root.innerHTML.indexOf('results-sign-out')).toBeGreaterThan(
      root.innerHTML.indexOf('results-site-settings'),
    );
  });

  // The label comes off the operator's own store and lands in a template
  // assigned to innerHTML.
  it('escapes a site label containing markup', () => {
    const { root } = render({ instanceLabel: '<img src=x onerror=alert(1)>' });
    expect(root.innerHTML).not.toContain('<img src=x');
    expect(root.innerHTML).toContain('&lt;img');
  });
});
