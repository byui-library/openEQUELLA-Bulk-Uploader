import { describe, it, expect } from 'vitest';
import {
  chooseCollectionSection,
  WITHHELD_COLLECTIONS_MESSAGE,
  type ChooseProps,
} from '../../../src/desktop/ui/screens/choose.js';

/**
 * The collection section is asserted as the markup it produces, not as a DOM:
 * this project deliberately has no jsdom (see screens/setup.ts's own tests).
 * The callbacks are never invoked here, so they are no-ops.
 */
const props = (over: Partial<ChooseProps> = {}): ChooseProps => ({
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
  ...over,
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
