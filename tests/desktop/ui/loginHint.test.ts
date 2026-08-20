// tests/desktop/ui/loginHint.test.ts
import { describe, it, expect } from 'vitest';
import { errorMessage } from '../../../src/desktop/ui/errors.js';
import { DEFAULT_LOGIN_HINT } from '../../../src/core/loginHint.js';

/**
 * ## A desktop operator has no shell
 *
 * REPORTED BY THE OPERATOR, who switched a site to OAuth and got this in the
 * collection field:
 *
 *   No cached OAuth token for https://content-test.byui.edu.
 *   Run:  oeq-upload login
 *
 * `getToken()` has no notion of which front end is asking, so it names the CLI
 * command -- correct for the CLI, useless in a window with no terminal, and
 * pointing at a command this operator has never run. `DEFAULT_LOGIN_HINT` is
 * exported precisely so a caller that DOES know can substitute its own; MCP
 * already does it through `runPreflight`, and the desktop never did.
 *
 * SUBSTITUTED IN THE RENDERER, at `errorMessage`, because that is where every
 * `window.oeq.*` rejection already funnels. Doing it per handler would fix the
 * collection list and leave the same sentence in every other auth failure.
 */
describe('the login instruction a desktop operator is given', () => {
  it('replaces the CLI command with something reachable from the app', () => {
    const shown = errorMessage(new Error(`No cached OAuth token for https://x.edu.\n${DEFAULT_LOGIN_HINT}`));
    expect(shown).not.toContain('oeq-upload');
    expect(shown).toMatch(/sign in/i);
  });

  it('keeps the reason the token was unusable', () => {
    const shown = errorMessage(new Error(`Cached OAuth token for https://x.edu expired at 2026-01-01.\n${DEFAULT_LOGIN_HINT}`));
    expect(shown).toContain('expired at 2026-01-01');
  });

  it('leaves an unrelated message alone', () => {
    expect(errorMessage(new Error('Something else went wrong.'))).toBe('Something else went wrong.');
  });

  /** Still strips Electron's IPC wrapper, which is what this function is for. */
  it('does both at once', () => {
    const wrapped = new Error(
      `Error invoking remote method 'oeq:listCollections': OeqError: No cached OAuth token for https://x.edu.\n${DEFAULT_LOGIN_HINT}`,
    );
    const shown = errorMessage(wrapped);
    expect(shown).not.toContain('invoking remote method');
    expect(shown).not.toContain('oeq-upload');
  });
});

/**
 * ## The three ways a token is unusable are different problems
 *
 * `getToken` already tells them apart -- absent, expired, issued for another
 * site -- and each carries the CLI hint that the desktop substitutes. What must
 * not happen is the substitution flattening them into one sentence: "sign in
 * again" is right for an expired token, and misleading for one that belongs to
 * a different site, where the real fault is the address or the stored token.
 */
describe('an unusable token says which kind of unusable', () => {
  const shown = (reason: string): string => errorMessage(new Error(`${reason}\n${DEFAULT_LOGIN_HINT}`));

  it('keeps "no token" distinct', () => {
    const m = shown('No cached OAuth token for https://oeq.example.edu.');
    expect(m).toContain('No cached OAuth token');
    expect(m).toMatch(/sign in/i);
  });

  it('keeps "expired", with when', () => {
    const m = shown('Cached OAuth token for https://oeq.example.edu expired at 2026-01-01T00:00:00.000Z.');
    expect(m).toContain('expired at 2026-01-01T00:00:00.000Z');
  });

  it('keeps "issued for another site", naming both', () => {
    const m = shown(
      'Cached OAuth token was issued for https://other.example.edu, not https://oeq.example.edu -- refusing to reuse it across instances.',
    );
    expect(m).toContain('https://other.example.edu');
    expect(m).toContain('https://oeq.example.edu');
    expect(m).toMatch(/refusing to reuse/i);
  });

  /** The point of the block: three inputs, three different sentences. */
  it('does not flatten them into one message', () => {
    const messages = new Set([
      shown('No cached OAuth token for https://x.edu.'),
      shown('Cached OAuth token for https://x.edu expired at 2026-01-01T00:00:00.000Z.'),
      shown('Cached OAuth token was issued for https://y.edu, not https://x.edu -- refusing to reuse it across instances.'),
    ]);
    expect(messages.size).toBe(3);
  });
});
