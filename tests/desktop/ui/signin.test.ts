import { describe, it, expect } from 'vitest';
import { signinMode } from '../../../src/desktop/ui/signin.js';
import type { CurrentUser } from '../../../src/core/client.js';

const user: CurrentUser = { username: 'alovelace', firstName: 'Ada', lastName: 'Lovelace' };

describe('signinMode', () => {
  it('is missing-credentials when the selected instance has no saved credentials', () => {
    expect(signinMode(false, null)).toBe('missing-credentials');
  });

  // Missing credentials must win even if the caller is still holding a user
  // value left over from a PREVIOUSLY selected instance -- app.ts clears
  // `user` on instance change, but this function must not rely on that: a
  // stale signed-in user must never mask "this instance has no
  // credentials" and let the screen imply a real sign-in already happened.
  it('is missing-credentials even if a stale user value is still present', () => {
    expect(signinMode(false, user)).toBe('missing-credentials');
  });

  it('is needs-signin when credentials exist but no one is signed in', () => {
    expect(signinMode(true, null)).toBe('needs-signin');
  });

  it('is signed-in when credentials exist and a user is present', () => {
    expect(signinMode(true, user)).toBe('signed-in');
  });
});
