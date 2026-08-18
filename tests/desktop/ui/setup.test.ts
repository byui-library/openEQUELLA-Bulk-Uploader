import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  attachmentPathCandidates,
  attachmentPathToFill,
  attachmentPathVerdict,
  backLabel,
  instanceFrom,
  modelEntryProblem,
  modelFrom,
  renderSetup,
  setupMarkup,
  settingsFrom,
  suggestAttachmentPath,
  MODEL_ADDRESS_LABEL,
  MODEL_FIELD_DEFAULTS,
  MODEL_NAME_LABEL,
  TEXT_INPUTS,
  type SetupFields,
  type SetupProps,
} from '../../../src/desktop/ui/screens/setup.js';
import type { ModelSettings } from '../../../src/desktop/secrets.js';
import { parseSchema } from '../../../src/core/discovery.js';
import { FakeElement } from '../../helpers/fakeDom.js';

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
  modelBaseUrl: '',
  modelName: '',
  modelKey: '',
  modelBudget: '',
  modelCap: '',
  modelTimeout: '',
  ...over,
});

/** A model endpoint as the renderer sees one: no key, only whether there is one. */
const MODEL = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3',
  budget: 8000,
  cap: 200,
  timeoutMs: 120_000,
  hasApiKey: false,
};

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
  storedOAuth: null,
  storage: null,
  modelList: null,
  onListModels: () => {},
  onForgetOAuth: () => {},
  collections: null,
  collectionsError: null,
  collectionsWithheld: false,
  schemaPaths: null,
  attachmentPathFilled: false,
  storedModel: null,
  modelSectionOpen: false,
  onForgetModel: () => {},
  onModelSectionToggle: () => {},
  error: null,
  saving: false,
  onInstanceChange: () => {},
  onFieldChange: () => {},
  onAuthModeChange: () => {},
  onCollectionChange: () => {},
  onLiveChange: () => {},
  onForgetPassword: () => {},
  onSave: () => {},
  // First run by default: nowhere to go back to, so no Back is offered.
  returnTo: null,
  onBack: () => {},
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

  /**
   * THE SHAPE, SHOWN. The datalist helps only an operator who already knows
   * what they are looking for; a placeholder shows what one of these looks
   * like before they have chosen a collection at all.
   *
   * It must be a MADE-UP path. A real `BYUI_extended/...` in shipped UI is
   * exactly what this codebase spent a branch removing, and a placeholder is
   * the one place a hardcoded institution path would look like a default.
   */
  it('shows an example of the shape, and never this institution’s own path', () => {
    const html = setupMarkup(props({ collections: COLLECTIONS, schemaPaths: null }));
    const input = /<input[^>]*id="setup-attachment-path"[^>]*>/.exec(html)?.[0];
    expect(input).toBeDefined();
    const placeholder = /placeholder="([^"]*)"/.exec(input ?? '')?.[1];
    expect(placeholder).toBeDefined();
    expect(placeholder).toContain('attachments/attachment');
    expect(placeholder).not.toMatch(/BYUI/i);
  });

  /**
   * TWO THINGS SHARE THE WORD "ATTACHMENT" and the label has to separate
   * them. The file is attached through openEQUELLA's attachment API whatever
   * this box says; only some schemas ALSO declare a metadata field recording
   * that attachment's ID. An operator who read the old label ("Field that
   * holds the attachment ID") concluded the attachment itself depended on it.
   */
  it('says what the field is, and that the file is attached either way', () => {
    const html = setupMarkup(props());
    const label = /<label for="setup-attachment-path">([\s\S]*?)<\/label>/.exec(html)?.[1];
    expect(label).toBeDefined();
    const text = (label ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toMatch(/records the attachment ID/i);
    expect(text).toMatch(/attached either way/i);
  });
});

/**
 * The same lookup core/preflight.ts's attachmentFieldCheck makes, said where
 * the value is entered. This field is written on EVERY item the runner
 * creates, so a wrong path is a mistake repeated across the whole batch.
 */
describe('attachmentPathVerdict', () => {
  const PATHS = ['MWDL/title', 'BYUI_extended/attachments/attachment'];

  // Blank is a real answer -- "record no such field" -- and not an error. The
  // message says what it means rather than leaving it to be inferred.
  it('treats blank as the deliberate choice it is', () => {
    const verdict = attachmentPathVerdict('', PATHS);
    expect(verdict.kind).toBe('blank');
    expect(verdict.message).toMatch(/nothing is recorded/i);
    expect(verdict.message).toContain('BYUI_extended/attachments/attachment');
  });

  it('treats whitespace as blank', () => {
    expect(attachmentPathVerdict('   ', PATHS).kind).toBe('blank');
  });

  /**
   * THE REGRESSION THAT EMPTIED A REAL STORE. On the first pass through Setup
   * no collection is chosen, so there is no schema to check against -- and the
   * blank branch used to answer "correct for most schemas" regardless. That is
   * a statement about schemas in general, made to someone who has been told
   * nothing about their own, and it reads as settled. The operator's stored
   * attachment path was empty for exactly this reason.
   *
   * Blank stays legitimate (kind is still `blank`, not an error), but the
   * message must not claim correctness it has not established.
   */
  it('does not call blank correct when it has no schema to check against', () => {
    const verdict = attachmentPathVerdict('', null);
    expect(verdict.kind).toBe('blank');
    expect(verdict.message).toMatch(/not been checked/i);
    expect(verdict.message).toMatch(/choose one above/i);
    // Nothing that only a read schema could justify saying -- neither the old
    // "correct for most schemas" nor a claim about what this schema declares.
    expect(verdict.message).not.toMatch(/correct for most schemas/i);
    expect(verdict.message).not.toMatch(/declares/i);
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
    // Blank is still legitimate: it means nothing is recorded, not that
    // anything is broken.
    expect(verdict.message).toMatch(/nothing is recorded/i);
  });

  /**
   * LEAD WITH THE ANSWER. For the operator whose schema DOES declare the field
   * -- the one case where blank is silent data loss -- opening with a general
   * remark about blank being normal buries the only fact that applies to them.
   * The candidate comes first; what blank costs follows it.
   */
  it('names the candidate before saying what blank means', () => {
    const verdict = attachmentPathVerdict('', ['MWDL/title', 'local/attachments/attachment']);
    expect(verdict.kind).toBe('blank');
    const named = verdict.message.indexOf('local/attachments/attachment');
    const blank = verdict.message.search(/left blank/i);
    expect(named).toBeGreaterThanOrEqual(0);
    expect(blank).toBeGreaterThanOrEqual(0);
    expect(named).toBeLessThan(blank);
  });

  /**
   * NO CANDIDATE MEANS THE SCHEMA HAS NO SUCH FIELD, and that is what it must
   * say. The old copy answered with a reassurance about schemas in general
   * ("correct for most schemas"), which the operator read as evasion -- "I
   * thought that the attachment-uuid was a requirement". A fact about THEIR
   * schema is both plainer and stronger.
   *
   * It must still name no path at all: a guessed one would be BYU-Idaho's
   * answer everywhere.
   */
  it('says the schema declares no such field, rather than reassuring about schemas in general', () => {
    const verdict = attachmentPathVerdict('', ['MWDL/title', 'MWDL/description']);
    expect(verdict.kind).toBe('blank');
    expect(verdict.message).toMatch(/declares no field/i);
    expect(verdict.message).not.toMatch(/most schemas/i);
    expect(verdict.message).not.toMatch(/[A-Za-z_]+\/[A-Za-z_]+/);
  });

  // Nothing is filled in by RENDERING. The one fill this app does is a
  // consequence of choosing a collection and happens once, in app.ts -- see
  // attachmentPathToFill below.
  it('does not fill the field in as a side effect of rendering', () => {
    expect(instanceFrom(props({ schemaPaths: ['local/attachments/attachment'] })).attachmentUuidPath)
      .toBe('');
    const html = setupMarkup(
      props({ collections: COLLECTIONS, schemaPaths: ['local/attachments/attachment'] }),
    );
    const input = /<input[^>]*id="setup-attachment-path"[^>]*>/.exec(html)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('value=""');
  });
});

/**
 * EVERY field the schema declares that could hold an attachment uuid, not just
 * the best one. The difference is the whole safety argument for filling the box
 * in: one candidate is an answer, two are a choice that belongs to the
 * operator, and `suggestAttachmentPath` alone cannot tell those apart -- it
 * returns a string either way.
 */
describe('attachmentPathCandidates', () => {
  it('finds the one field a schema declares for it', () => {
    expect(attachmentPathCandidates(['MWDL/title', 'local/attachments/attachment'])).toEqual([
      'local/attachments/attachment',
    ]);
  });

  it('finds every one when a schema declares more than one', () => {
    expect(
      attachmentPathCandidates(['MWDL/title', 'b/attachments/attachment', 'a/attachment']),
    ).toEqual(['a/attachment', 'b/attachments/attachment']);
  });

  it('finds none where a schema declares none, and none at all without a schema', () => {
    expect(attachmentPathCandidates(['MWDL/title'])).toEqual([]);
    expect(attachmentPathCandidates(null)).toEqual([]);
  });

  /**
   * THE CASE THE OPERATOR ACTUALLY HAS, pinned against the schema recorded from
   * content.byui.edu itself rather than a hand-written list. BYUI_MWDL declares
   * exactly one such leaf, so the fill below is an answer and not a guess.
   *
   * `item/attachments/attachment` is correctly not among them: it has children
   * (`type`, `attributes/entry/string`), so it is a container, and openEQUELLA
   * cannot store a value at one -- discovery.ts's walker emits leaves only.
   */
  it('yields exactly one candidate for the real BYU-Idaho schema', () => {
    const schema = parseSchema(JSON.parse(readFileSync('tests/fixtures/api/schema.json', 'utf8')));
    expect(attachmentPathCandidates([...schema.paths])).toEqual([
      'BYUI_extended/attachments/attachment',
    ]);
  });
});

/**
 * THE DECISION TO FILL THE BOX IN, kept pure and kept here so it can be
 * asserted without a DOM. WHEN it is applied is app.ts's business and is the
 * part that makes a cleared field stay cleared (see appNavigation.test.ts):
 * this answers only "may it be filled", never "fill it again".
 *
 * The operator asked for exactly this -- "have the system populate that field
 * based on the schema, similar to how we're able to get a list of collections"
 * -- and the reason it is safe is that a schema either declares one such field
 * or it does not. Choosing between two would be an institution-specific
 * assumption, which is the class of bug this branch exists to remove.
 */
describe('attachmentPathToFill', () => {
  it('offers the single candidate for an empty field', () => {
    expect(attachmentPathToFill(['MWDL/title', 'local/attachments/attachment'], '')).toBe(
      'local/attachments/attachment',
    );
  });

  /**
   * NEVER OVER WHAT THE OPERATOR TYPED. A path they entered themselves is the
   * one piece of evidence on this screen about what their site really uses, and
   * a schema-derived guess must not overwrite it.
   */
  it('offers nothing when the field already holds something', () => {
    expect(attachmentPathToFill(['local/attachments/attachment'], 'MWDL/mine')).toBeNull();
    // Even when what they typed is the candidate itself: there is nothing to do.
    expect(
      attachmentPathToFill(['local/attachments/attachment'], 'local/attachments/attachment'),
    ).toBeNull();
    // Whitespace is blank, and a blank-looking field is filled.
    expect(attachmentPathToFill(['local/attachments/attachment'], '   ')).toBe(
      'local/attachments/attachment',
    );
  });

  it('offers nothing when the schema declares more than one', () => {
    expect(attachmentPathToFill(['a/attachment', 'b/attachment'], '')).toBeNull();
  });

  it('offers nothing when the schema declares none, and nothing without a schema', () => {
    expect(attachmentPathToFill(['MWDL/title'], '')).toBeNull();
    expect(attachmentPathToFill(null, '')).toBeNull();
  });
});

/**
 * WHAT THE OPERATOR IS TOLD once the box has been filled in for them. Somebody
 * who never typed this needs to know why it is there and that it is theirs to
 * change; "Found in this collection's schema" is true but reads as a verdict on
 * something they did.
 */
describe('the filled-in verdict', () => {
  const PATHS = ['MWDL/title', 'local/attachments/attachment'];

  it('says it was filled in from the schema, and that it can be changed', () => {
    const verdict = attachmentPathVerdict('local/attachments/attachment', PATHS, true);
    expect(verdict.kind).toBe('filled');
    expect(verdict.message).toMatch(/filled in for you/i);
    expect(verdict.message).toMatch(/schema/i);
    expect(verdict.message).toMatch(/change it or clear it/i);
  });

  // A path the operator typed themselves gets the verdict it always got.
  it('is not what a typed path gets', () => {
    expect(attachmentPathVerdict('local/attachments/attachment', PATHS).kind).toBe('declared');
    expect(attachmentPathVerdict('local/attachments/attachment', PATHS, false).kind).toBe('declared');
  });

  // The screen renders it, with its own class -- it is confirmed, like
  // `declared`, but it is not the same event.
  it('is what the screen renders', () => {
    const html = setupMarkup(
      props({
        collections: COLLECTIONS,
        schemaPaths: PATHS,
        attachmentPathFilled: true,
        fields: fields({ attachmentUuidPath: 'local/attachments/attachment' }),
      }),
    );
    expect(html).toContain('verdict--filled');
    expect(html).toMatch(/filled in for you/i);
  });
});

/**
 * SEVERAL CANDIDATES IS A CHOICE, NOT A GUESS. Picking between two would be
 * this tool inventing an institution's answer, which is exactly what naming
 * `BYUI_extended/...` in shipped code used to do.
 */
describe('a schema declaring several attachment fields', () => {
  const PATHS = ['MWDL/title', 'a/attachment', 'b/attachments/attachment'];

  it('fills nothing and names them all', () => {
    const verdict = attachmentPathVerdict('', PATHS);
    expect(verdict.kind).toBe('blank');
    expect(verdict.message).toContain('a/attachment');
    expect(verdict.message).toContain('b/attachments/attachment');
    expect(verdict.message).toMatch(/more than one/i);
  });

  it('sends the operator to the box rather than deciding for them', () => {
    expect(attachmentPathVerdict('', PATHS).message).toMatch(/choose/i);
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

/**
 * SETUP WAS A ONE-WAY DOOR. Its only control was "Save credentials", so an
 * operator who opened it from Choose to check one setting could only leave by
 * saving -- and saving is exactly what somebody who came to LOOK does not want
 * to do. The way out has to cost nothing and has to say so.
 *
 * IT MUST NOT EXIST ON FIRST RUN. Setup is the launch screen when no site has
 * been added, and there is genuinely nowhere behind it; a Back there would
 * either do nothing or invent a destination. `returnTo` is null in exactly that
 * case (app.ts's `setupEnteredFrom`, cleared by `seedSetupForm`).
 */
describe('the way back out of Setup', () => {
  it('offers no Back on first run, where there is nowhere to return to', () => {
    expect(setupMarkup(props({ returnTo: null }))).not.toContain('id="setup-back"');
  });

  it('offers Back when Setup was opened from another screen', () => {
    expect(setupMarkup(props({ returnTo: 'choose' }))).toContain('id="setup-back"');
    expect(setupMarkup(props({ returnTo: 'signin' }))).toContain('id="setup-back"');
  });

  /**
   * NAMES THE DESTINATION, because there are three screens Setup can be opened
   * from and a bare "Back" leaves the operator guessing which one they are
   * about to land on.
   */
  it('names where Back goes', () => {
    expect(backLabel('choose')).toBe('Back to choosing what to upload');
    expect(backLabel('signin')).toBe('Back to sign in');
    expect(backLabel('results')).toBe('Back to the upload summary');
    expect(setupMarkup(props({ returnTo: 'choose' }))).toContain('Back to choosing what to upload');
  });

  /**
   * SAYS WHAT IT COSTS. The one thing an operator cannot see is whether
   * leaving throws away what they typed, or -- far worse, and the mistake the
   * neighbouring "Change credentials…" route really does make -- something
   * already saved.
   */
  it('says nothing typed is kept and nothing saved is touched', () => {
    const html = setupMarkup(props({ returnTo: 'choose' }));
    expect(html).toMatch(/without saving/i);
    expect(html).toMatch(/nothing already saved is changed or removed/i);
  });

  // Back sits left of Save, as it does on Review and Confirm, and takes the
  // same low-emphasis `secondary` treatment so it cannot be mistaken for the
  // action the screen exists for.
  it('is a secondary button left of Save credentials', () => {
    const html = setupMarkup(props({ returnTo: 'choose' }));
    expect(html.indexOf('setup-back')).toBeLessThan(html.indexOf('Save credentials'));
    expect(html).toMatch(/id="setup-back"[^>]*class="secondary"|class="secondary"[^>]*id="setup-back"/);
  });

  // type="button", not a second submit: this button is inside #setup-form, and
  // a default-type button there would SAVE -- the precise thing Back exists to
  // avoid, failing in the most expensive possible direction.
  it('is not a submit button', () => {
    const html = setupMarkup(props({ returnTo: 'choose' }));
    const back = html.slice(html.indexOf('id="setup-back"') - 40, html.indexOf('id="setup-back"') + 120);
    expect(back).toContain('type="button"');
  });

  it('calls onBack when clicked, and saves nothing', () => {
    const root = new FakeElement();
    const calls = { back: 0, save: 0 };
    renderSetup(root as unknown as HTMLElement, props({
      returnTo: 'choose',
      onBack: () => (calls.back += 1),
      onSave: () => (calls.save += 1),
    }));
    root.fire('#setup-back');
    expect(calls).toEqual({ back: 1, save: 0 });
  });
});

/**
 * The standing note under the attachment field.
 *
 * It exists because the operator arrived at this screen holding openEQUELLA's
 * own sync documentation, which names `item/attachments/attachment/uuid` --
 * and typing that here is wrong. It is not in the schema, so this screen would
 * answer their site's documented path with "not declared", which reads as the
 * tool being broken rather than as the path being generated elsewhere.
 *
 * So the note must appear WHATEVER the verdict says: the operator who most
 * needs it is the one looking at a field that has just been filled in for them
 * with something different from what they expected.
 */
describe('the sync caveat under the attachment field', () => {
  const STATES: [string, Partial<SetupProps>][] = [
    ['no collection chosen', {}],
    ['schema read, field blank', { schemaPaths: ['MWDL/title'] }],
    [
      'filled in from the schema',
      {
        schemaPaths: ['BYUI_extended/attachments/attachment'],
        fields: fields({ attachmentUuidPath: 'BYUI_extended/attachments/attachment' }),
        attachmentPathFilled: true,
      },
    ],
    [
      'a path the schema does not declare',
      { schemaPaths: ['MWDL/title'], fields: fields({ attachmentUuidPath: 'nope/at/all' }) },
    ],
  ];

  for (const [state, over] of STATES) {
    it(`is shown when ${state}`, () => {
      expect(setupMarkup(props(over))).toContain('item/attachments/attachment/uuid');
    });
  }

  /**
   * The path is named as somewhere openEQUELLA generates, never as a value to
   * enter. If it ever migrates into the verdict line -- the line that says
   * whether what is typed is valid -- it becomes a recommendation the same
   * screen then rejects.
   */
  it('names the generated path as generated, not as something to type', () => {
    const html = setupMarkup(props({ schemaPaths: ['MWDL/title'] }));
    expect(html).toMatch(/generated when the file is\s+attached/);
    expect(html).toMatch(/needs nothing here/);
    // Not inside the verdict paragraph, which is about what has been typed.
    const verdictLine = /<p class="hint verdict[^"]*">([^<]*)</.exec(html)?.[1] ?? '';
    expect(verdictLine).not.toContain('item/attachments/attachment/uuid');
  });

  /** The answer that settles it without needing this tool to be right. */
  it('points at the wizard as the thing to match', () => {
    expect(setupMarkup(props())).toMatch(/own web interface and match whatever it writes/);
  });
});

/**
 * ## What "the feature does not exist when nothing is configured" means HERE
 *
 * The plan carried a test whose name and assertion disagreed --
 * `it('is not offered until an endpoint is entered')` asserting that the
 * endpoint FIELD is present. Both halves cannot be right, so this is what the
 * design actually asks for.
 *
 * The design says: "With no endpoint configured the feature does not exist. No
 * prompt, no error, no degraded mode, no mention on any screen." The thing that
 * must be absent is the **feature** -- the sending, the dialog, any claim that a
 * model wrote something. The endpoint FIELD is the one exception that proves it:
 * Setup is the screen that configures the thing, and a settings screen which
 * hides its own setting until that setting exists can never be used to create
 * it. So the field is unconditionally present here, and what is pinned instead
 * is that it stays out of the way, offers nothing to forget that does not
 * exist, and -- in tests/ai/confirm.test.ts and extract/controller.test.ts -- that no
 * document is sent and no dialog is shown until an endpoint is stored.
 */
describe('the Setup screen’s model section', () => {
  it('always offers the endpoint field, because nothing could ever be configured otherwise', () => {
    expect(setupMarkup(props())).toContain('id="setup-model-base-url"');
    expect(setupMarkup(props())).toContain('id="setup-model-name"');
  });

  /** A local endpoint needs no key, and asking for one implies it does. */
  it('says the key is only needed for a hosted endpoint', () => {
    expect(setupMarkup(props())).toMatch(/hosted/i);
    expect(setupMarkup(props())).toMatch(/model running on this computer needs no key/i);
  });

  /**
   * OUT OF THE WAY UNTIL IT IS SET UP. The overwhelming majority of
   * installations configure no model at all, and a section shouting at them on
   * the one screen every operator must complete is the "mention on a screen"
   * the design rules out. Collapsed is not hidden: the same treatment the
   * Advanced OAuth disclosure already gets.
   */
  it('is collapsed by default', () => {
    expect(setupMarkup(props())).toMatch(/<details id="setup-model"(?!\s+open)/);
  });

  /**
   * OPEN COMES FROM PROPS, NEVER FROM `storedModel`. This screen re-renders on
   * every keystroke, so an operator who expanded the section to type their
   * first endpoint -- the one case where nothing is stored -- had it close
   * again on the first character, taking the caret with it. Derived the other
   * way round it would also spring back open every time they closed it.
   * `app.ts` opens it once, when it finds something stored, and after that the
   * operator decides (appNavigation.test.ts drives both directions).
   */
  it('is open when the app says so, whatever is or is not stored', () => {
    expect(setupMarkup(props({ modelSectionOpen: true }))).toMatch(/<details id="setup-model" open/);
    expect(setupMarkup(props({ modelSectionOpen: true, storedModel: MODEL }))).toMatch(
      /<details id="setup-model" open/,
    );
  });

  it('is closed when the app says so, even with an endpoint stored', () => {
    expect(setupMarkup(props({ storedModel: MODEL }))).toMatch(/<details id="setup-model"(?!\s+open)/);
  });

  it('offers nothing to forget when nothing is configured', () => {
    expect(setupMarkup(props())).not.toContain('id="setup-model-forget"');
  });

  it('offers a way to remove it once one is stored, and names what is stored', () => {
    const html = setupMarkup(props({ storedModel: MODEL }));
    expect(html).toContain('id="setup-model-forget"');
    expect(html).toContain('llama3');
    expect(html).toContain('localhost:11434');
  });

  /** The same rule as the password: a stored secret is never rendered back
   *  into a field where it can be read off the screen or copied out. */
  it('never renders a stored key back into the box', () => {
    const html = setupMarkup(props({ storedModel: { ...MODEL, hasApiKey: true } }));
    expect(html).not.toContain('sk-');
    expect(html).toMatch(/key is stored/i);
  });

  it('carries every typed model box in TEXT_INPUTS, or the caret is lost after one character', () => {
    for (const id of [
      'setup-model-base-url',
      'setup-model-name',
      'setup-model-key',
      'setup-model-budget',
      'setup-model-cap',
      'setup-model-timeout',
    ]) {
      expect(TEXT_INPUTS).toContain(`#${id}`);
    }
  });

  it('renders every input TEXT_INPUTS names, so the list cannot outlive the markup', () => {
    const html = setupMarkup(props({ storedModel: MODEL }));
    for (const selector of TEXT_INPUTS) {
      expect(html).toContain(`id="${selector.slice(1)}"`);
    }
  });
});

describe('modelFrom', () => {
  const withModel = (over: Partial<SetupFields> = {}): SetupProps =>
    props({
      fields: fields({
        modelBaseUrl: 'http://localhost:11434/v1',
        modelName: 'llama3',
        modelKey: '',
        modelBudget: '8000',
        modelCap: '200',
        modelTimeout: '120',
        ...over,
      }),
    });

  /** The settings, for the assertions that are about the numbers rather than
   *  about which of the three answers came back. */
  const settingsOf = (entry: ReturnType<typeof modelFrom>) => {
    expect(entry.kind).toBe('settings');
    return (entry as { kind: 'settings'; settings: ModelSettings }).settings;
  };

  /** Nothing typed, nothing configured. This is the zero-prerequisite promise
   *  arriving at the one screen that could break it. */
  it('is ‘none’ when no endpoint is entered', () => {
    expect(modelFrom(props())).toEqual({ kind: 'none' });
  });

  /**
   * THE DEFECT. This used to be the SAME `null` as the case above, so `app.ts`
   * stored nothing, ran the ordinary success path, and the operator's typed
   * model name vanished with the save reporting success.
   */
  it('is ‘incomplete’, not ‘none’, when an address is entered but no model is named', () => {
    const entry = modelFrom(withModel({ modelName: '  ' }));
    expect(entry.kind).toBe('incomplete');
  });

  it('is ‘incomplete’ when a model is named but no address is entered', () => {
    expect(modelFrom(withModel({ modelBaseUrl: '   ' })).kind).toBe('incomplete');
  });

  /** A key is not typed by accident, and it is the one box whose contents the
   *  operator cannot recover by looking at the screen. */
  it('is ‘incomplete’ when only a key was typed', () => {
    const entry = modelFrom(
      props({ fields: fields({ modelKey: 'sk-typed', modelBudget: '8000', modelCap: '200', modelTimeout: '120' }) }),
    );
    expect(entry.kind).toBe('incomplete');
  });

  /**
   * THE ZERO-PREREQUISITE CASE, PINNED. The three numbers arrive pre-filled, so
   * reading them as "the operator started configuring a model" would fire the
   * refusal on every fresh form -- an operator who has never opened this section
   * being told to fix a setting they have never seen.
   */
  it('is ‘none’, silently, when only the pre-filled numbers are present', () => {
    const entry = modelFrom(
      props({
        fields: fields({
          modelBudget: MODEL_FIELD_DEFAULTS.budget,
          modelCap: MODEL_FIELD_DEFAULTS.cap,
          modelTimeout: MODEL_FIELD_DEFAULTS.timeout,
        }),
      }),
    );
    expect(entry).toEqual({ kind: 'none' });
  });

  it('reads the whole endpoint back', () => {
    expect(modelFrom(withModel())).toEqual({
      kind: 'settings',
      settings: {
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3',
        apiKey: '',
        budget: 8000,
        cap: 200,
        timeoutMs: 120_000,
      },
    });
  });

  /** Seconds on screen, milliseconds on the wire. An operator does not think
   *  in milliseconds, and `ProviderConfig.timeoutMs` does not think in seconds. */
  it('reads the time limit in seconds and stores it in milliseconds', () => {
    expect(settingsOf(modelFrom(withModel({ modelTimeout: '300' }))).timeoutMs).toBe(300_000);
  });

  /**
   * A BLANK BOX IS NOT ZERO. `Number('')` is 0, and a cap of 0 is a legitimate
   * setting meaning "make no requests at all" -- so a blank box read that way
   * would configure a model that silently never runs, and every row would say
   * it was stopped by a limit the operator never set. NaN is refused by
   * core's own guard with a sentence naming the setting.
   *
   * NOT by this screen: a blank NUMBER is still a complete endpoint as far as
   * `modelFrom` is concerned, and the rule about what the number may be belongs
   * to the code that runs with it.
   */
  it.each(['modelBudget', 'modelCap', 'modelTimeout'] as const)(
    'refuses a blank %s rather than reading it as zero',
    (field) => {
      const settings = settingsOf(modelFrom(withModel({ [field]: '   ' })));
      expect(Object.values(settings).some((v) => typeof v === 'number' && Number.isNaN(v))).toBe(true);
    },
  );

  it('hands a mistyped number through as NaN, for the store’s own guard to refuse', () => {
    expect(settingsOf(modelFrom(withModel({ modelCap: 'lots' }))).cap).toBeNaN();
  });
});

/**
 * What the operator is told when the model section is half filled in.
 *
 * The sentence is asserted here, and that it REACHES A SCREEN is asserted in
 * appNavigation.test.ts, which drives a real save through app.ts. Both are
 * needed: a message no screen shows is the defect wearing a different face.
 */
describe('modelEntryProblem', () => {
  const half = (over: Partial<SetupFields>): string | null => modelEntryProblem(fields(over));

  /** THE PROPERTY THAT MUST NOT MOVE. An operator who never touched the section
   *  sees no prompt, no error and no mention of a model, on any path. */
  it('says nothing at all about an untouched section', () => {
    expect(modelEntryProblem(fields())).toBeNull();
    expect(
      modelEntryProblem(
        fields({
          modelBudget: MODEL_FIELD_DEFAULTS.budget,
          modelCap: MODEL_FIELD_DEFAULTS.cap,
          modelTimeout: MODEL_FIELD_DEFAULTS.timeout,
        }),
      ),
    ).toBeNull();
  });

  it('says nothing about a complete endpoint', () => {
    expect(half({ modelBaseUrl: 'http://localhost:11434/v1', modelName: 'llama3' })).toBeNull();
  });

  /**
   * NAMES THE BOX, BY THE NAME ON THE BOX. A refusal that says "the model
   * settings are incomplete" and stops sends the operator hunting through six
   * fields; the label constants are shared with the markup so the two cannot
   * drift into calling the same field different things.
   */
  it('names the model-name box when only the address was filled in', () => {
    const message = half({ modelBaseUrl: 'http://localhost:11434/v1' });
    expect(message).toContain(MODEL_NAME_LABEL);
    expect(message).not.toContain(MODEL_ADDRESS_LABEL);
  });

  it('names the address box when only the model was named', () => {
    const message = half({ modelName: 'llama3' });
    expect(message).toContain(MODEL_ADDRESS_LABEL);
    expect(message).not.toContain(MODEL_NAME_LABEL);
  });

  it('names both when only a key was typed', () => {
    const message = half({ modelKey: 'sk-typed' });
    expect(message).toContain(MODEL_ADDRESS_LABEL);
    expect(message).toContain(MODEL_NAME_LABEL);
  });

  /**
   * SAYS NOTHING WAS SAVED, in as many words. The whole defect was a save that
   * reported success while discarding what was typed, so the correction is
   * worthless if the operator can read it as "saved, with a note".
   */
  it('says nothing has been saved', () => {
    expect(half({ modelName: 'llama3' })).toMatch(/nothing has been saved/i);
  });

  /** And offers the other way out, because "fill in the box" is not the only
   *  thing an operator who half-typed something may want to do. */
  it('offers emptying the section as the way to leave the feature off', () => {
    expect(half({ modelName: 'llama3' })).toMatch(/empty the model section/i);
  });

  /** The names it uses are the names the screen renders, not a second copy. */
  it('uses labels the screen actually shows', () => {
    const html = setupMarkup(props());
    expect(html).toContain(MODEL_ADDRESS_LABEL);
    expect(html).toContain(MODEL_NAME_LABEL);
  });
});
