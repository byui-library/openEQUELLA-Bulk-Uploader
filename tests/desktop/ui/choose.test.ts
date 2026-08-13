import { describe, it, expect } from 'vitest';
import {
  chooseCollectionSection,
  renderChoose,
  WITHHELD_COLLECTIONS_MESSAGE,
  type ChooseProps,
} from '../../../src/desktop/ui/screens/choose.js';
import { FakeElement } from '../../helpers/fakeDom.js';

/**
 * The collection section is asserted as the markup it produces, not as a DOM:
 * this project deliberately has no jsdom (see screens/setup.ts's own tests).
 * The callbacks are never invoked here, so they are no-ops.
 */
const props = (over: Partial<ChooseProps> = {}): ChooseProps => ({
  instanceLabel: 'Library',
  collections: null,
  collectionsError: null,
  collectionsWithheld: false,
  query: '',
  collectionUuid: null,
  sheetPath: null,
  folderPath: null,
  error: null,
  readyMessage: null,
  starterKitSaving: false,
  starterKitMessage: null,
  onQueryChange: () => {},
  onSelectCollection: () => {},
  onChooseSpreadsheet: () => {},
  onChooseFolder: () => {},
  onSaveStarterKit: () => {},
  onContinue: () => {},
  onExtract: () => {},
  onSiteSettings: () => {},
  onSignOut: () => {},
  ...over,
});

function render(over: Partial<ChooseProps> = {}): {
  root: FakeElement;
  siteSettings: number;
  signOut: number;
} {
  const root = new FakeElement();
  const counters = { siteSettings: 0, signOut: 0 };
  renderChoose(
    root as unknown as HTMLElement,
    props({
      onSiteSettings: () => (counters.siteSettings += 1),
      onSignOut: () => (counters.signOut += 1),
      ...over,
    }),
  );
  return {
    root,
    get siteSettings() {
      return counters.siteSettings;
    },
    get signOut() {
      return counters.signOut;
    },
  };
}

/**
 * REPORTED BY THE OPERATOR while installing the tool: "There isn't a way to go
 * back to setup once you are on the main screen where you select a collection."
 *
 * And it was circular. Setup names a suggested attachment path only once a
 * collection has been chosen, because that is when its schema can be read --
 * and the collection is chosen HERE, on the screen with no route back. The
 * guidance was reachable only from the screen the operator had to leave in
 * order to produce it.
 */
describe('the route back to Setup', () => {
  it('offers a settings link naming the site', () => {
    const { root } = render();
    expect(root.has('#choose-site-settings')).toBe(true);
    expect(root.innerHTML).toContain('Library');
  });

  it('calls onSiteSettings, and nothing else, when it is clicked', () => {
    const rendered = render();
    rendered.root.fire('#choose-site-settings');
    expect(rendered.siteSettings).toBe(1);
  });

  /**
   * WORDING. "Settings" alone leaves an operator mid-task guessing whether the
   * link will cost them the collection, spreadsheet and folder they have
   * already picked -- and an operator who guesses wrong skips the setting,
   * which is the failure this whole change exists to remove. So it names the
   * attachment field (the setting they are being sent for) and says plainly
   * that the three choices survive.
   */
  it('says what the link is for and that the work in progress survives', () => {
    const { root } = render();
    expect(root.innerHTML).toMatch(/attachment ID/i);
    expect(root.innerHTML).toMatch(/collection, spreadsheet and folder are kept/i);
  });

  // It must not compete with Continue: same low-emphasis treatment Sign-in
  // gives its own settings link, and below the primary action rather than
  // among the numbered steps.
  it('is a link-button below Continue, not a button beside it', () => {
    const { root } = render();
    expect(root.innerHTML).toContain('class="link-button"');
    expect(root.innerHTML.indexOf('choose-site-settings')).toBeGreaterThan(
      root.innerHTML.indexOf('choose-continue-btn'),
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

/**
 * THE BANNER NAMES THE SITE; THIS IS HOW THE OPERATOR LEAVES IT.
 *
 * The red banner exists to tell an operator which site they are pointed at,
 * because a collection uuid can be byte-identical on two of them and there is
 * no undo. An operator who reads it, realises it is the wrong one, and wants to
 * move had no route short of restarting the app: a safety cue with no
 * corresponding action is half a safety feature.
 *
 * Sign-in is where a site is chosen, and `nextScreen('choose', signedOut)`
 * already routed there -- nothing on this screen fired it.
 */
describe('the route back to Sign-in', () => {
  it('offers a sign-out control naming the site', () => {
    const { root } = render();
    expect(root.has('#choose-sign-out')).toBe(true);
    expect(root.innerHTML).toContain('Sign out of Library');
  });

  it('calls onSignOut, and nothing else, when it is clicked', () => {
    const rendered = render();
    rendered.root.fire('#choose-sign-out');
    expect(rendered.signOut).toBe(1);
    expect(rendered.siteSettings).toBe(0);
  });

  /**
   * WORDING. Choose is pre-run, so nothing has been uploaded and the click
   * costs only the three selections -- and an operator who cannot tell those
   * two apart will not click it at all. Say both.
   */
  it('says the session ends, that a different site can be picked, and what it costs', () => {
    const { root } = render();
    expect(root.innerHTML).toMatch(/sign-in screen/i);
    expect(root.innerHTML).toMatch(/different site/i);
    expect(root.innerHTML).toMatch(/nothing has been uploaded/i);
  });

  // Same low-emphasis treatment as the settings link beside it: neither may
  // compete with Continue, which is the action this screen exists for.
  it('is a link-button below Continue, beside the settings link', () => {
    const { root } = render();
    expect(root.innerHTML.indexOf('choose-sign-out')).toBeGreaterThan(
      root.innerHTML.indexOf('choose-continue-btn'),
    );
    expect(root.innerHTML.indexOf('choose-sign-out')).toBeGreaterThan(
      root.innerHTML.indexOf('choose-site-settings'),
    );
  });

  it('escapes a site label containing markup', () => {
    const { root } = render({ instanceLabel: '<img src=x onerror=alert(1)>' });
    expect(root.innerHTML).not.toContain('<img src=x');
  });
});

/**
 * REPORTED BY THE OPERATOR, against a live instance. This dropdown read
 * "showing 0 of 0 -- No collections match" for a session that was not signed
 * in at all, which is indistinguishable from an account that genuinely has no
 * collections -- and nothing anywhere on the screen said they were not signed
 * in. openEQUELLA does not refuse an unauthenticated request: it answers 200
 * with the true count and none of the rows.
 */
describe('the collection section', () => {
  it('says the list was withheld rather than showing an empty dropdown', () => {
    const html = chooseCollectionSection(props({ collections: [], collectionsWithheld: true }));
    expect(html).toContain(WITHHELD_COLLECTIONS_MESSAGE);
    // Not "no collections match", which is the sentence that shipped.
    expect(html).not.toContain('No collections match');
    // ...and not a select the operator can fruitlessly search.
    expect(html).not.toContain('<select');
  });

  // The message has to say the two things the operator could not work out for
  // themselves: that this is a sign-in problem, and that the collections do
  // exist.
  it('names guest, says the collections exist, and points at the sign-in', () => {
    expect(WITHHELD_COLLECTIONS_MESSAGE).toMatch(/guest/i);
    expect(WITHHELD_COLLECTIONS_MESSAGE).toMatch(/exist/i);
    expect(WITHHELD_COLLECTIONS_MESSAGE).toMatch(/sign in|sign-in/i);
  });

  /**
   * A GENUINELY EMPTY LIST IS A DIFFERENT STATE and must keep reading as one.
   * An account that holds CREATE_ITEM on nothing is legitimate, and telling
   * them to check a sign-in that worked would send them to the wrong place.
   */
  it('leaves a genuinely empty list reading as an empty list', () => {
    const html = chooseCollectionSection(props({ collections: [], collectionsWithheld: false }));
    expect(html).toContain('No collections match');
    expect(html).not.toContain(WITHHELD_COLLECTIONS_MESSAGE);
  });

  it('still shows the dropdown when the list arrived', () => {
    const html = chooseCollectionSection(
      props({ collections: [{ uuid: 'c1', name: 'Faculty Content', schemaUuid: 's1' }] }),
    );
    expect(html).toContain('Faculty Content');
    expect(html).toContain('showing 1 of 1');
  });

  // An error is not a withheld list either: one is a host that cannot be
  // reached, the other is a host answering perfectly well as nobody.
  it('reports a read failure as a read failure', () => {
    const html = chooseCollectionSection(props({ collectionsError: 'connect ECONNREFUSED' }));
    expect(html).toContain('connect ECONNREFUSED');
    expect(html).not.toContain(WITHHELD_COLLECTIONS_MESSAGE);
  });
});
