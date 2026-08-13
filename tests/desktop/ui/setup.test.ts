import { describe, it, expect } from 'vitest';
import {
  attachmentPathVerdict,
  instanceFrom,
  setupMarkup,
  settingsFrom,
  suggestAttachmentPath,
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
  attachmentUuidPath: '',
  collectionUuid: '',
  live: true,
  ...over,
});

const props = (over: Partial<SetupProps> = {}): SetupProps => ({
  instances: [
    {
      id: 'https://oeq.example.edu',
      label: 'Live',
      baseUrl: 'https://oeq.example.edu',
      authMode: 'password',
      attachmentUuidPath: '',
      live: true,
      schemaUuid: '',
    },
  ],
  instanceId: 'https://oeq.example.edu',
  credentialsDropped: false,
  fields: fields(),
  storedUsername: null,
  collections: null,
  collectionsError: null,
  collectionsWithheld: false,
  schemaPaths: null,
  error: null,
  saving: false,
  onInstanceChange: () => {},
  onFieldChange: () => {},
  onAuthModeChange: () => {},
  onCollectionChange: () => {},
  onLiveChange: () => {},
  onForgetPassword: () => {},
  onSave: () => {},
  ...over,
});

const COLLECTIONS = [
  { uuid: 'coll-1', name: 'Faculty Content', schemaUuid: 'schema-1' },
  { uuid: 'coll-2', name: 'Alumni Obituaries', schemaUuid: 'schema-2' },
];

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
 * Radios and checkboxes are excluded on purpose: neither has a caret -- and
 * `keepCaret` would call `setSelectionRange` on one, which a browser refuses
 * outright -- and their state is re-rendered from props.
 */
describe('caret preservation', () => {
  /** Input types with no caret to keep. `keepCaret` must never be pointed at one. */
  const CARETLESS = new Set(['radio', 'checkbox']);

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
      // The collection section only renders with a saved site and a list, and
      // it carries a typed field of its own.
      setupMarkup(props({ collections: COLLECTIONS, schemaPaths: ['MWDL/title'] })),
    ];
    const typed = new Set(
      rendered.flatMap((html) => inputs(html).filter((i) => !CARETLESS.has(i.type)).map((i) => `#${i.id}`)),
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

/**
 * The dropdown that replaced a uuid box. It lists what this account can
 * actually contribute to (`GET /collection?privilege=CREATE_ITEM`), so a wrong
 * collection is something the operator can see rather than something they
 * discover after a batch has landed in it.
 */
describe('the collection dropdown', () => {
  it('lists every collection the account can contribute to', () => {
    const html = setupMarkup(props({ collections: COLLECTIONS }));
    expect(html).toContain('id="setup-collection"');
    expect(html).toContain('Faculty Content');
    expect(html).toContain('Alumni Obituaries');
    expect(html).toContain('value="coll-1"');
  });

  it('marks the chosen one as selected', () => {
    const html = setupMarkup(
      props({ collections: COLLECTIONS, fields: fields({ collectionUuid: 'coll-2' }) }),
    );
    expect(html).toMatch(/value="coll-2"\s+selected/);
    expect(html).not.toMatch(/value="coll-1"\s+selected/);
  });

  /**
   * An account holding CREATE_ITEM on nothing is a REAL state -- exactly what
   * a viewer-only account looks like -- with a remedy that belongs to an
   * openEQUELLA administrator. An empty `<select>` would read as a broken app
   * and send the operator debugging their address or their password, which are
   * both fine.
   */
  it('says so plainly when the account can contribute nowhere, rather than showing an empty list', () => {
    const html = setupMarkup(props({ collections: [] }));
    expect(html).not.toContain('id="setup-collection"');
    expect(html).toContain('CREATE_ITEM');
    expect(html).toMatch(/administrator/i);
  });

  // Unread is not empty. The two have no fix in common.
  it('reports a list that could not be read as unread, not as empty', () => {
    const html = setupMarkup(props({ collections: null, collectionsError: 'fetch failed' }));
    expect(html).toContain('fetch failed');
    expect(html).not.toContain('CREATE_ITEM');
  });

  it('explains, rather than erroring, before any site has been saved', () => {
    const html = setupMarkup(props({ instanceId: '', collections: null }));
    expect(html).not.toContain('id="setup-collection"');
    expect(html).not.toContain('role="alert"');
    expect(html).toMatch(/save your sign-in details first/i);
  });

  /**
   * WITHHELD IS NOT EMPTY, and it is not a read failure either. openEQUELLA
   * answers an unauthenticated request 200 with the true count and zero rows,
   * so this state arrives looking like a perfectly successful call. Reported
   * as "you hold CREATE_ITEM on nothing" it sends the operator to an
   * administrator over their own sign-in.
   */
  it('says the list was withheld rather than that the account holds nothing', () => {
    const html = setupMarkup(props({ collections: [], collectionsWithheld: true }));
    expect(html).toMatch(/guest/i);
    expect(html).not.toContain('holds <strong>CREATE_ITEM</strong> on no collection');
    expect(html).not.toContain('id="setup-collection"');
  });

  // The names come off the wire and this markup is assigned to innerHTML.
  it('escapes a collection name containing markup', () => {
    const html = setupMarkup(
      props({ collections: [{ uuid: 'c', name: '<img src=x onerror=alert(1)>', schemaUuid: 's' }] }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

/**
 * The field whose absence was silent. See session.test.ts for the regression
 * itself; this is the screen that now collects it.
 */
describe('the attachment-uuid path', () => {
  it('is a field on this screen, holding what was typed', () => {
    const html = setupMarkup(props({ fields: fields({ attachmentUuidPath: 'BYUI_extended/attachments/attachment' }) }));
    expect(html).toContain('id="setup-attachment-path"');
    expect(html).toContain('value="BYUI_extended/attachments/attachment"');
  });

  /**
   * The "offer" half: where the schema is known, its valid xpaths are on the
   * dropdown so the operator picks one instead of having to know it. A
   * datalist suggests rather than constrains, so a site whose schema could not
   * be read can still type the path it knows is right.
   */
  it('offers the schema’s own paths once a collection is chosen', () => {
    const html = setupMarkup(props({ collections: COLLECTIONS, schemaPaths: ['MWDL/title', 'MWDL/description'] }));
    expect(html).toContain('list="setup-schema-paths"');
    expect(html).toContain('<datalist id="setup-schema-paths">');
    expect(html).toContain('value="MWDL/description"');
  });

  it('offers nothing to pick from when no schema has been read', () => {
    const html = setupMarkup(props({ collections: COLLECTIONS, schemaPaths: null }));
    expect(html).not.toContain('<datalist');
    expect(html).not.toContain('list="setup-schema-paths"');
  });
});

/**
 * The same lookup core/preflight.ts's attachmentFieldCheck makes, said where
 * the value is entered. This field is written on EVERY item the runner
 * creates, so a wrong path is a mistake repeated across the whole batch.
 */
describe('attachmentPathVerdict', () => {
  const PATHS = ['MWDL/title', 'BYUI_extended/attachments/attachment'];

  // Blank is the DEFAULT and correct for most schemas. It is not an error, and
  // the message says what it means rather than leaving it to be inferred.
  it('treats blank as the deliberate choice it is', () => {
    const verdict = attachmentPathVerdict('', PATHS);
    expect(verdict.kind).toBe('blank');
    expect(verdict.message).toMatch(/no attachment-uuid field is written/i);
  });

  it('treats whitespace as blank', () => {
    expect(attachmentPathVerdict('   ', PATHS).kind).toBe('blank');
  });

  it('confirms a path the schema declares', () => {
    expect(attachmentPathVerdict('BYUI_extended/attachments/attachment', PATHS).kind).toBe('declared');
  });

  it('refuses a path the schema does not declare, and says how many it has', () => {
    const verdict = attachmentPathVerdict('MWDL/nope', PATHS);
    expect(verdict.kind).toBe('undeclared');
    expect(verdict.message).toContain('2 valid paths');
  });

  /**
   * COULD NOT CHECK IS NEVER CLEAN. With no schema read there is no evidence
   * either way, and reporting a typed path as fine would be inventing some --
   * the same rule findDuplicates and the pre-flight both follow.
   */
  it('reports an unchecked path as unchecked, never as correct', () => {
    const verdict = attachmentPathVerdict('MWDL/title', null);
    expect(verdict.kind).toBe('unchecked');
    expect(verdict.kind).not.toBe('declared');
    expect(verdict.message).toMatch(/not checked/i);
  });

  it('is what the screen actually renders', () => {
    const html = setupMarkup(
      props({ collections: COLLECTIONS, schemaPaths: PATHS, fields: fields({ attachmentUuidPath: 'MWDL/nope' }) }),
    );
    expect(html).toContain('verdict--undeclared');
    expect(html).toContain('2 valid paths');
  });
});

/**
 * The banner is the only durable cue telling an operator which site they are
 * pointed at, and it is loud only for a site marked live. This is the one
 * thing the app cannot work out for itself.
 */
describe('the live-site flag', () => {
  it('is ticked by default', () => {
    const html = setupMarkup(props({ collections: COLLECTIONS }));
    expect(html).toContain('id="setup-live"');
    expect(html).toMatch(/id="setup-live"[\s\S]*?checked/);
  });

  it('is unticked when the operator has said the site is not live', () => {
    const html = setupMarkup(props({ collections: COLLECTIONS, fields: fields({ live: false }) }));
    expect(html).toMatch(/id="setup-live"/);
    expect(html).not.toMatch(/id="setup-live"[\s\S]*?checked/);
  });

  /**
   * ON THE SCREEN WHERE A SITE IS ADDED, which is the one Setup pass every
   * operator definitely makes. This checkbox and the attachment path used to
   * live inside the collection section, which returns early for a site that
   * has not been saved yet -- so neither was rendered at all, and saving went
   * straight on to Sign-in. Unless the operator later found "Settings for
   * {site}…", the live flag was never a decision and the attachment path was
   * never even mentioned; both were blank in the operator's real store.
   *
   * Neither needs the network or a saved site. Only the collection dropdown
   * does, and it still waits.
   */
  it('is on screen for a site that has not been saved yet', () => {
    const html = setupMarkup(props({ instanceId: '', collections: null }));
    expect(html).toContain('id="setup-live"');
    expect(html).toContain('id="setup-attachment-path"');
    // ...and the dropdown still waits for credentials to ask with.
    expect(html).not.toContain('id="setup-collection"');
  });
});

/**
 * BLANK MUST BE A CHOICE, NOT AN ACCIDENT. The operator's real store had this
 * empty with nothing on screen having ever mentioned it, so every item they
 * created silently lost the field. Reachable at all only now the collection
 * list asks for `full=true`: without it no collection carries a schema uuid,
 * so no schema was ever read and there was nothing to offer.
 */
describe('suggestAttachmentPath', () => {
  it('names the schema path that looks like the attachment field', () => {
    expect(
      suggestAttachmentPath(['MWDL/title', 'BYUI_extended/attachments/attachment', 'MWDL/date']),
    ).toBe('BYUI_extended/attachments/attachment');
  });

  it('offers nothing when the schema declares nothing like one', () => {
    expect(suggestAttachmentPath(['MWDL/title', 'MWDL/description'])).toBeNull();
  });

  /**
   * A guess made without a schema would be BYU-Idaho's answer at every
   * institution -- the exact class of bug this work exists to remove. Null in,
   * null out.
   */
  it('guesses nothing when no schema has been read', () => {
    expect(suggestAttachmentPath(null)).toBeNull();
  });

  // Shortest wins, then alphabetical, so a deeply nested near-miss cannot
  // outrank the obvious one and the answer does not depend on server order.
  it('picks the shortest candidate, deterministically', () => {
    expect(suggestAttachmentPath(['a/b/c/deep/attachment', 'local/attachments'])).toBe(
      'local/attachments',
    );
    // Equal length: alphabetical, so the answer does not depend on server order.
    expect(suggestAttachmentPath(['bb/attachment', 'aa/attachment'])).toBe('aa/attachment');
  });

  it('tells the operator what blank means, and names the candidate', () => {
    const verdict = attachmentPathVerdict('', ['MWDL/title', 'local/attachments/attachment']);
    expect(verdict.kind).toBe('blank');
    expect(verdict.message).toContain('local/attachments/attachment');
    // Still says blank is legitimate -- it is, for most schemas.
    expect(verdict.message).toMatch(/no attachment-uuid field is written/);
  });

  // Nothing is ever filled in on the operator's behalf: blank is a real answer
  // and writing metadata they did not ask for goes on every item in every batch.
  it('does not fill the field in', () => {
    expect(instanceFrom(props({ schemaPaths: ['local/attachments/attachment'] })).attachmentUuidPath)
      .toBe('');
  });
});

describe('instanceFrom', () => {
  it('carries the attachment path, trimmed', () => {
    const built = instanceFrom(props({ fields: fields({ attachmentUuidPath: '  MWDL/x  ' }) }));
    expect(built.attachmentUuidPath).toBe('MWDL/x');
  });

  // Blank means "write no such field". Coercing it would put metadata the
  // operator never asked for on every item in every batch.
  it('keeps blank as blank rather than filling something in', () => {
    expect(instanceFrom(props()).attachmentUuidPath).toBe('');
  });

  it('defaults the site to live', () => {
    expect(instanceFrom(props()).live).toBe(true);
  });

  it('carries a site the operator marked not live', () => {
    expect(instanceFrom(props({ fields: fields({ live: false }) })).live).toBe(false);
  });

  /**
   * The schema uuid comes off the chosen collection's OWN list entry --
   * `parseCollections` keeps `schema.uuid` on every one precisely so this
   * costs no extra request. It is the address of the cached schema that
   * extraction later reads offline.
   */
  it('takes the schema uuid from the chosen collection, not from anything typed', () => {
    const built = instanceFrom(props({ collections: COLLECTIONS, fields: fields({ collectionUuid: 'coll-2' }) }));
    expect(built.schemaUuid).toBe('schema-2');
  });

  it('resolves no schema when no collection has been chosen', () => {
    expect(instanceFrom(props({ collections: COLLECTIONS })).schemaUuid).toBe('');
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
