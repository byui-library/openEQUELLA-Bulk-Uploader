import { describe, it, expect } from 'vitest';
import {
  setupMarkup,
  settingsFrom,
  TEXT_INPUTS,
  type SetupFields,
  type SetupProps,
} from '../../../src/desktop/ui/screens/setup.js';

/**
 * The Setup screen is asserted as the markup it produces, not as a DOM: this
 * project deliberately has no jsdom, and the existing screen tests
 * (ui/duplicates.ts and duplicatesMarkup.test.ts) read the string a renderer
 * builds. The callbacks are never invoked here, so they are no-ops.
 */
const fields = (over: Partial<SetupFields> = {}): SetupFields => ({
  baseUrl: 'https://oeq.example.edu',
  label: 'Live',
  authMode: 'password',
  clientId: '',
  clientSecret: '',
  redirectUri: 'https://oeq.example.edu',
  username: '',
  password: '',
  ...over,
});

const props = (over: Partial<SetupProps> = {}): SetupProps => ({
  instances: [{ id: 'https://oeq.example.edu', label: 'Live', baseUrl: 'https://oeq.example.edu' }],
  instanceId: 'https://oeq.example.edu',
  credentialsDropped: false,
  fields: fields(),
  storedUsername: null,
  error: null,
  saving: false,
  onInstanceChange: () => {},
  onFieldChange: () => {},
  onAuthModeChange: () => {},
  onForgetPassword: () => {},
  onSave: () => {},
  ...over,
});

/** The markup between `<details ...>` and its closing tag: what the disclosure hides. */
function disclosure(html: string): string {
  const start = html.indexOf('<details');
  const end = html.indexOf('</details>');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('the Setup screen', () => {
  /**
   * Username and password is what a new institution can use on the day it
   * installs this tool -- no OAuth client to request from an administrator
   * first. It is therefore the default, and it is on screen without the
   * operator having to find it.
   */
  it('offers the username and password fields by default', () => {
    const html = setupMarkup(props());
    expect(html).toContain('id="setup-username"');
    expect(html).toContain('id="setup-password"');
    expect(disclosure(html)).not.toContain('id="setup-username"');
  });

  it('selects the username and password method by default', () => {
    expect(setupMarkup(props())).toMatch(/id="setup-auth-password"[\s\S]*?checked/);
  });

  // For the SSO-backed sites -- BYU-Idaho among them -- and out of the way of
  // everybody else.
  it('keeps the OAuth fields behind the Advanced disclosure', () => {
    const hidden = disclosure(setupMarkup(props()));
    expect(hidden).toContain('id="setup-client-id"');
    expect(hidden).toContain('id="setup-client-secret"');
    expect(hidden).toContain('id="setup-redirect-uri"');
  });

  it('leaves the disclosure shut in password mode and open in OAuth mode', () => {
    expect(setupMarkup(props())).toMatch(/<details id="setup-advanced"\s*>/);
    expect(setupMarkup(props({ fields: fields({ authMode: 'code' }) }))).toMatch(
      /<details id="setup-advanced"\s+open\s*>/,
    );
  });

  it('renders no password box in OAuth mode', () => {
    const html = setupMarkup(props({ fields: fields({ authMode: 'code' }) }));
    expect(html).not.toContain('id="setup-username"');
    expect(html).not.toContain('id="setup-password"');
  });

  // The fields are controlled (screens/setup.ts), so a re-render has to put
  // back exactly what was typed -- otherwise choosing a sign-in method wipes
  // the address the operator just entered.
  it('renders what has been typed back into every field', () => {
    const html = setupMarkup(
      props({
        fields: fields({
          authMode: 'code',
          baseUrl: 'https://library.example.edu/oeq',
          label: 'Library',
          clientId: 'cid',
          clientSecret: 'sec',
          redirectUri: 'https://library.example.edu/oeq/',
        }),
      }),
    );
    expect(html).toContain('value="https://library.example.edu/oeq"');
    expect(html).toContain('value="Library"');
    expect(html).toContain('value="cid"');
    expect(html).toContain('value="sec"');
    expect(html).toContain('value="https://library.example.edu/oeq/"');
  });
});

/**
 * The caret rule, guarded statically because it cannot be guarded any other
 * way here: this project has no jsdom, so nothing can observe an input losing
 * focus across a re-render. Every field on this screen is controlled, so every
 * keystroke replaces the whole screen's innerHTML and destroys the box being
 * typed into; an input missing from TEXT_INPUTS therefore loses focus after
 * one character, or types backwards (ui/dom.ts#keepCaret). Both of those
 * shipped unnoticed for months, and neither showed up in a test.
 *
 * Radios are excluded on purpose: they have no caret, and their state is
 * re-rendered from props.
 */
describe('caret preservation', () => {
  /** Every `<input>` in some markup, as `{ id, type }`. */
  function inputs(html: string): { id: string; type: string }[] {
    return [...html.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => ({
      id: /id="([^"]+)"/.exec(m[0])?.[1] ?? '',
      type: /type="([^"]+)"/.exec(m[0])?.[1] ?? '',
    }));
  }

  it('covers every typed field this screen can render', () => {
    const rendered = [
      setupMarkup(props()),
      setupMarkup(props({ fields: fields({ authMode: 'code' }) })),
      setupMarkup(props({ storedUsername: 'm.miles' })),
    ];
    const typed = new Set(
      rendered.flatMap((html) => inputs(html).filter((i) => i.type !== 'radio').map((i) => `#${i.id}`)),
    );

    expect([...typed].sort()).toEqual([...TEXT_INPUTS].sort());
  });

  it('actually found some inputs, rather than passing on an empty set', () => {
    // Guards the guard: a regex that matched nothing would make the test above
    // agree with any list at all, including an empty one.
    expect(inputs(setupMarkup(props())).length).toBeGreaterThan(3);
  });
});

describe('a stored password', () => {
  it('is shown as who is signed in, with nothing to retype', () => {
    const html = setupMarkup(props({ storedUsername: 'm.miles' }));
    expect(html).toContain('Signed in as');
    expect(html).toContain('m.miles');
    expect(html).not.toContain('id="setup-password"');
    expect(html).not.toContain('id="setup-username"');
  });

  it('offers the Forget control only when something is actually stored', () => {
    expect(setupMarkup(props({ storedUsername: 'm.miles' }))).toContain('id="setup-forget-password"');
    expect(setupMarkup(props())).not.toContain('id="setup-forget-password"');
  });

  it('says where the password is kept and who can read it', () => {
    const html = setupMarkup(props({ storedUsername: 'm.miles' }));
    expect(html).toContain('encrypted for your Windows account only');
    expect(html).toContain('Another user on this PC cannot read it');
  });

  // The username came off disk, and this markup is assigned to innerHTML.
  it('escapes a username containing markup', () => {
    const html = setupMarkup(props({ storedUsername: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('settingsFrom', () => {
  it('builds password settings from what was typed', () => {
    const settings = settingsFrom(props({ fields: fields({ username: ' m.miles ', password: 'hunter2' }) }));
    expect(settings).toEqual({ authMode: 'password', username: 'm.miles', password: 'hunter2' });
  });

  /**
   * With an account already stored the form shows "Signed in as ..." and no
   * password box, so it submits the stored username and an EMPTY password --
   * which secrets.ts reads as "leave the stored password alone". That is what
   * lets an operator rename a site without typing their password again.
   */
  it('submits an empty password when one is already stored, keeping the stored username', () => {
    const settings = settingsFrom(props({ storedUsername: 'm.miles' }));
    expect(settings).toEqual({ authMode: 'password', username: 'm.miles', password: '' });
  });

  it('builds OAuth settings in OAuth mode, trimming what was pasted', () => {
    const settings = settingsFrom(
      props({
        fields: fields({
          authMode: 'code',
          clientId: ' cid ',
          clientSecret: 'sec',
          redirectUri: ' https://oeq.example.edu/ ',
        }),
      }),
    );
    expect(settings).toEqual({
      authMode: 'code',
      clientId: 'cid',
      clientSecret: 'sec',
      // Verbatim apart from the surrounding whitespace: the trailing slash is
      // registered on the OAuth client and has been guessed wrong twice here.
      redirectUri: 'https://oeq.example.edu/',
    });
  });
});
