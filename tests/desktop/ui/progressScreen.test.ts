import { describe, it, expect } from 'vitest';
import { progressMarkup, renderProgress } from '../../../src/desktop/ui/screens/progress.js';

/**
 * The Progress screen is asserted as the markup it produces plus the one
 * post-render DOM call, not as a real DOM: this project deliberately has no
 * jsdom, and the other screen tests (setup.test.ts, duplicatesMarkup.test.ts)
 * read the string a renderer builds.
 *
 * The `style=` assertion is the load-bearing one. index.html's CSP is
 * `default-src 'self'` with no `style-src`, so Chromium refuses an inline
 * style ATTRIBUTE -- the fill's width silently stayed empty and the bar never
 * moved, from v0.1.0 until this test existed. The width must therefore be
 * assigned through the DOM API, which the CSP does not govern.
 */
function fakeRoot(): { root: HTMLElement; fill: { style: { width: string } } } {
  const fill = { style: { width: '' } };
  const root = {
    innerHTML: '',
    querySelector(selector: string): unknown {
      if (selector !== '.progress-bar__fill') return null;
      return this.innerHTML.includes('progress-bar__fill') ? fill : null;
    },
  };
  return { root: root as unknown as HTMLElement, fill };
}

const props = (over: Partial<Parameters<typeof progressMarkup>[0]> = {}) => ({
  done: 0,
  total: 37,
  fileName: 'Smith_Jane.mp4',
  log: [],
  ...over,
});

describe('progressMarkup', () => {
  it('carries no inline style attribute -- the CSP would drop it', () => {
    expect(progressMarkup(props({ done: 5 }))).not.toMatch(/style\s*=/);
  });

  it('still announces the percentage to assistive tech', () => {
    expect(progressMarkup(props({ done: 5 }))).toContain('aria-valuenow="14"');
  });

  it('escapes a filename containing markup', () => {
    const html = progressMarkup(props({ fileName: '<img src=x onerror=alert(1)>.mp4' }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

/**
 * A RUN IN PROGRESS MUST NOT BE INTERRUPTIBLE. Choose and Results both carry
 * "Sign out of {site}…" and "Site settings for {site}…", and this screen is the
 * one place between them where either would be a data hazard: signing out under
 * a running batch ends the openEQUELLA session the runner is uploading through,
 * mid-file, with items already created and no undo.
 *
 * The protection is that this screen renders no such control -- not a disabled
 * one, not a hidden one. Asserted as the absence of any button at all, which is
 * both what is true today and the shape that catches a control added here later
 * by somebody applying the pattern uniformly.
 */
describe('the Progress screen offers no way off it', () => {
  it('renders no buttons at all', () => {
    expect(progressMarkup(props({ done: 5 }))).not.toMatch(/<button/i);
  });

  it('renders neither of the site-level actions the other screens carry', () => {
    const html = progressMarkup(props({ done: 5 }));
    expect(html).not.toMatch(/sign out/i);
    expect(html).not.toMatch(/site settings/i);
  });
});

describe('renderProgress', () => {
  it('sets the fill width to 0% at the start', () => {
    const { root, fill } = fakeRoot();
    renderProgress(root, props({ done: 0 }));
    expect(fill.style.width).toBe('0%');
  });

  it('sets the fill width to a partial percentage', () => {
    const { root, fill } = fakeRoot();
    renderProgress(root, props({ done: 5 }));
    expect(fill.style.width).toBe('14%');
  });

  it('sets the fill width to 100% when the batch is done', () => {
    const { root, fill } = fakeRoot();
    renderProgress(root, props({ done: 37 }));
    expect(fill.style.width).toBe('100%');
  });
});
