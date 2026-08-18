// tests/desktop/wideScreen.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * ## A screen that asks to be wide must actually get to be wide
 *
 * `.screen.wide { max-width: 62rem }` existed and did nothing at all: `#app`
 * caps every screen at 760px, and a child cannot exceed its parent's
 * max-width. So the columns screen -- five columns, one of them holding schema
 * paths seventy characters long -- was laid out in 760px and its source column
 * was squeezed to a couple of words per line. Reported from a screenshot,
 * after it had been that way for as long as the rule existed.
 *
 * NOTHING IN THIS SUITE CAN SEE THAT. There is no jsdom and no layout engine
 * here, so "too narrow to read" is invisible and always will be. What this can
 * do is hold the two halves together: whatever width a wide screen asks for,
 * the page must grant the same one. An edit that changes one and forgets the
 * other fails here instead of shipping silently, which is how it shipped the
 * first time.
 */
describe('the wide screen and the page that has to make room for it', () => {
  const css = readFileSync('src/desktop/ui/styles.css', 'utf8');

  /** The max-width a selector declares, or null when it declares none. */
  const maxWidthOf = (selector: string): string | null => {
    const at = css.indexOf(selector + ' {');
    if (at === -1) return null;
    const body = css.slice(at, css.indexOf('}', at));
    const found = /max-width:\s*([^;]+);/.exec(body);
    return found === null ? null : found[1]!.trim();
  };

  it('declares a width for a wide screen', () => {
    expect(maxWidthOf('.screen.wide')).not.toBeNull();
  });

  it('grants the page that same width when a wide screen is on it', () => {
    expect(maxWidthOf('#app:has(.screen.wide)')).toBe(maxWidthOf('.screen.wide'));
  });

  /**
   * Reachable only through `:has()`. Electron 33 is Chromium 130 and supports
   * it; pinned so a future rewrite onto something that does not cannot quietly
   * return to a dead rule.
   */
  it('widens the page with a selector rather than by asking the screen nicely', () => {
    expect(css).toContain('#app:has(.screen.wide)');
  });

  /**
   * `table-layout: fixed` is what stops one long schema path taking the width
   * the source column needs. The obituary template's death-date path is 74
   * characters.
   */
  it('gives the columns table a layout that does not size to its longest path', () => {
    expect(css).toMatch(/table\.columns\s*\{[^}]*table-layout:\s*fixed/);
  });
});
