import { describe, it, expect } from 'vitest';
import { signinMode } from '../../../src/desktop/ui/signin.js';
import {
  signinBusyLabel,
  signinHint,
  signinMarkup,
  type SigninProps,
} from '../../../src/desktop/ui/screens/signin.js';
import type { CurrentUser } from '../../../src/core/client.js';

// A REAL account: `guest: false`. openEQUELLA answers an unauthenticated
// request as the guest identity rather than refusing it, so a CurrentUser on
// its own is no longer proof that anyone signed in -- handlers.ts refuses a
// guest at the sign-in channel and reports null from the currentUser one, and
// this screen's states are all about a user who got past that.
const user: CurrentUser = {
  id: 'u-42',
  username: 'alovelace',
  firstName: 'Ada',
  lastName: 'Lovelace',
  guest: false,
};

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

/**
 * The copy told every operator "This opens an openEQUELLA sign-in window".
 * That is true of the authorization-code flow and simply UNTRUE in password
 * mode, where the handler signs in directly with the stored account and no
 * window ever appears (handlers.ts's signIn). Someone told to expect a window
 * that never comes has no way to tell a working sign-in from a broken one.
 */
describe('the Sign-in button’s copy', () => {
  it('promises a window in the flow that actually opens one', () => {
    expect(signinHint('code')).toMatch(/sign-in window/i);
    expect(signinBusyLabel('code')).toMatch(/window/i);
  });

  it('promises no window in password mode, where none opens', () => {
    expect(signinHint('password')).not.toMatch(/opens an openEQUELLA sign-in window/i);
    expect(signinHint('password')).toMatch(/username and password/i);
    expect(signinBusyLabel('password')).not.toMatch(/window/i);
  });

  // The failure being fixed is precisely that both modes said the same thing.
  it('says something different in each mode', () => {
    expect(signinHint('password')).not.toBe(signinHint('code'));
    expect(signinBusyLabel('password')).not.toBe(signinBusyLabel('code'));
  });
});

describe('signinMarkup', () => {
  const site = (id: string, label: string, live: boolean) => ({
    id,
    label,
    baseUrl: id,
    authMode: 'password' as const,
    attachmentUuidPath: '',
    live,
    collectionUuid: '',
    schemaUuid: '',
  });
  const base: SigninProps = {
    instances: [site('https://oeq.example.edu', 'Live', true), site('https://oeq-test.example.edu', 'Sandbox', false)],
    instanceId: 'https://oeq.example.edu',
    instanceHasSettings: true,
    user: null,
    checkingUser: false,
    signingIn: false,
    error: null,
    onInstanceChange: () => {},
    onSignIn: () => {},
    onSignOut: () => {},
    onContinue: () => {},
    onAddCredentials: () => {},
    onAddSite: () => {},
    onSiteSettings: () => {},
    onResetSettings: () => {},
  };

  it('labels the dropdown "Site" and lists every saved site', () => {
    const html = signinMarkup(base);
    expect(html).toMatch(/<label for="signin-instance">Site<\/label>/);
    expect(html).toContain('>Live</option>');
    expect(html).toContain('>Sandbox</option>');
  });

  /**
   * A BUTTON, NOT AN OPTION IN THE DROPDOWN: on Windows, arrowing through a
   * closed <select> fires `change` for every option passed, so an option that
   * navigates would drop an operator stepping between two sites into Setup.
   */
  it('offers "Add another site…" as a button, never as an option in the dropdown', () => {
    const html = signinMarkup(base);
    expect(html).toMatch(/<button id="add-site-btn" type="button"[^>]*>Add another site…<\/button>/);
    expect(html.match(/<select[\s\S]*?<\/select>/)![0]).not.toMatch(/Add another site/);
  });
});
