import type { InstanceChoice } from '../../ipc.js';
import type { CollectionSummary } from '../../../core/client.js';
// `import type`: secrets.ts reaches `node:fs`, and this module is rendered in
// the sandboxed renderer. A type-only import is erased at compile time and
// never becomes a runtime require -- see tests/desktop/rendererPurity.test.ts.
import type { Settings, SettingsAuthMode } from '../../secrets.js';
import type { Screen } from '../state.js';
import { escapeHtml, keepCaret } from '../dom.js';
import { setupNotice } from '../setupNotice.js';
// One wording for "the server withheld this list", shared with the Choose
// screen so the two cannot drift into describing the same state differently.
import { WITHHELD_COLLECTIONS_MESSAGE } from './choose.js';

/**
 * Everything the operator can type on this screen, held by the app rather
 * than by the DOM.
 *
 * CONTROLLED, and it has to be: choosing a sign-in method re-renders, and a
 * screen that renders by replacing `innerHTML` destroys every input it has
 * when it does. With the values in the DOM only, switching to Advanced would
 * silently erase the address the operator had just typed. Held here, the
 * re-render puts every field back exactly as it was -- and `keepCaret` (see
 * `renderSetup`) puts the caret back with it.
 */
export interface SetupFields {
  baseUrl: string;
  label: string;
  authMode: SettingsAuthMode;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  username: string;
  password: string;
  /**
   * Where each item's attachment uuid is written into its metadata, or '' for
   * "write no such field" -- which is a real choice, not an unfilled box.
   *
   * Filled in from the schema when the chosen collection declares exactly one
   * such field and this is empty (app.ts's `handleSetupCollectionChange`).
   * Never filled over what the operator typed, and never re-filled after they
   * clear it.
   */
  attachmentUuidPath: string;
  /**
   * The collection whose schema the attachment path is checked against.
   * NOT itself saved as a credential: it exists so choosing a collection can
   * resolve its schema in one hop (discovery.ts#parseCollections), and what
   * IS saved is the schema uuid it yields.
   */
  collectionUuid: string;
  /** Whether this is a live site. Defaults ON -- see the checkbox's own copy. */
  live: boolean;
}

/**
 * The typed fields, as opposed to everything on this screen that is chosen
 * rather than typed. Kept apart so `onFieldChange` cannot be handed a mode, a
 * uuid or a boolean as a bare string and have to re-validate it: each of those
 * has its own callback and its own type.
 */
export type SetupTextField = Exclude<keyof SetupFields, 'authMode' | 'collectionUuid' | 'live'>;

export interface SetupProps {
  /** Sites the operator has already added. Empty on a fresh install. */
  instances: InstanceChoice[];
  /** The saved instance being edited, or '' for a site not added yet. */
  instanceId: string;
  /** Whether credentials from an older version were found and discarded. */
  credentialsDropped: boolean;
  fields: SetupFields;
  /**
   * The account already stored for this instance, or null when there is none.
   *
   * The USERNAME only -- the password never comes back out of the main
   * process (see ipc.ts's `getPassword`). It is all this screen needs: a name
   * to show beside "Signed in as", and the fact that there is something to
   * forget.
   */
  storedUsername: string | null;
  /**
   * The collections this account can actually contribute to, or null when they
   * have not been read (no site saved yet, still loading, or the read failed).
   *
   * AN EMPTY ARRAY IS NOT NULL and must not render as one: an account holding
   * CREATE_ITEM on nothing is a real, diagnosable state -- exactly what a
   * viewer-only account looks like -- and the screen has to say so rather than
   * showing an empty dropdown that reads as a broken app.
   */
  collections: CollectionSummary[] | null;
  /** Why the collection list could not be read, if it could not be. */
  collectionsError: string | null;
  /**
   * The server reported that collections exist and returned none of them --
   * an unauthenticated session, not an account with nothing. A THIRD state,
   * distinct from both the empty array above and from `collectionsError`; see
   * core/discovery.ts's `CollectionList.withheld`.
   */
  collectionsWithheld: boolean;
  /**
   * Every valid xpath in the chosen collection's schema, or null when no
   * collection is chosen or its schema could not be read. Null means the
   * attachment path is UNCHECKED, which is reported as unchecked -- never as
   * correct.
   */
  schemaPaths: string[] | null;
  /**
   * Whether the path in the box was put there by this tool rather than typed.
   *
   * RENDERER STATE, HELD BY app.ts, and deliberately not derived here: "the
   * value happens to equal the schema's only candidate" is also true of an
   * operator who typed it themselves, and telling them the app did it would be
   * a lie about their own work. app.ts sets it at the one moment it is true --
   * the collection change that filled the box -- and clears it the instant the
   * operator edits the field.
   */
  attachmentPathFilled: boolean;
  error: string | null;
  saving: boolean;
  /**
   * The screen Setup was opened from, or null when there is nowhere to go back
   * to -- which is the case on first run, where Setup IS the launch screen, and
   * after "Change credentials…", which wipes every saved site and leaves a
   * Sign-in screen listing none.
   *
   * A Back offered in either of those states would do nothing or invent a
   * destination, so it is not offered. app.ts's `setupEnteredFrom` already
   * carried exactly this and is what feeds it.
   */
  returnTo: Screen | null;
  /**
   * Leave without saving.
   *
   * SETUP WAS A ONE-WAY DOOR: its only control was "Save credentials", so an
   * operator who came from Choose to check one setting could only leave by
   * saving -- which is precisely what somebody who came to LOOK does not want
   * to do, and which repoints the whole app at whatever site the form happens
   * to name.
   *
   * MUST CLEAR NOTHING. Not the store, not the form, not the stored password.
   * The destructive route stays where it is, on Sign-in, labelled
   * "Change credentials…" and behind a confirm.
   */
  onBack(): void;
  onInstanceChange(id: string): void;
  onFieldChange(field: SetupTextField, value: string): void;
  onAuthModeChange(mode: SettingsAuthMode): void;
  onCollectionChange(uuid: string): void;
  onLiveChange(live: boolean): void;
  onForgetPassword(): void;
  onSave(
    instance: {
      label: string;
      baseUrl: string;
      attachmentUuidPath: string;
      live: boolean;
      schemaUuid: string;
    },
    settings: Settings,
  ): void;
}

/**
 * Every text input on this screen, so the caret survives the re-render that
 * every keystroke causes. Any input added here must be added to this list --
 * without it the field loses focus after one character, or types backwards
 * (ui/dom.ts#keepCaret; both shipped unnoticed for months).
 */
export const TEXT_INPUTS = [
  '#setup-base-url',
  '#setup-label',
  '#setup-username',
  '#setup-password',
  '#setup-client-id',
  '#setup-client-secret',
  '#setup-redirect-uri',
  '#setup-attachment-path',
] as const;

/**
 * What Back says it goes back to.
 *
 * NAMES THE DESTINATION rather than saying "Back". Three screens can open
 * Setup now -- Sign-in, Choose and Results -- and an operator part-way through
 * a batch needs to know which one a click returns them to before they take it.
 *
 * Pure and exported for the same reason `bannerClass` is: this project has no
 * jsdom, so the wording is asserted directly.
 */
export function backLabel(returnTo: Screen): string {
  switch (returnTo) {
    case 'choose':
      return 'Back to choosing what to upload';
    case 'results':
      return 'Back to the upload summary';
    case 'signin':
      return 'Back to sign in';
    default:
      // No other screen opens Setup today. A bare "Back" is the honest answer
      // for one that starts to: vague, but never wrong about where it lands.
      return 'Back';
  }
}

/**
 * What the screen can say about the attachment-uuid path.
 *
 * `filled` is the one added for the schema-driven fill. It is deliberately NOT
 * `declared`: both mean the schema has this node, but only one of them is
 * something the operator did, and somebody who never typed the value has to be
 * told where it came from and that it is theirs to change.
 */
export interface AttachmentPathVerdict {
  kind: 'blank' | 'unchecked' | 'declared' | 'undeclared' | 'filled';
  message: string;
}

/**
 * Every path in this collection's schema that could hold an attachment uuid,
 * shortest first.
 *
 * PLURAL ON PURPOSE, and that is the whole safety argument for filling the box
 * in: one candidate is an answer, several are a choice belonging to the
 * operator, and none means the schema simply has no such field.
 * `suggestAttachmentPath` returns a string in all three cases and so cannot
 * tell them apart.
 *
 * Only ever derived from a schema that was actually read (null in, empty out):
 * a guess made without one would be BYU-Idaho's answer at every institution,
 * which is the exact class of bug this branch exists to remove. Reachable at
 * all only because the collection list now asks for `full=true` -- without it
 * no collection carries a schema uuid, so `schemaPaths` was null for
 * everybody.
 *
 * The last segment is what identifies one (`.../attachments/attachment`).
 * Containers cannot match even when they are named that way: `discovery.ts`'s
 * walker emits leaves only, and openEQUELLA cannot store a value at a node
 * with children -- which is why BYUI_MWDL's `item/attachments/attachment`,
 * which has `type` and `attributes/entry/string` beneath it, is correctly not
 * among these.
 *
 * Sorted shortest-first so a deeply nested near-miss cannot outrank the obvious
 * one, then alphabetically so the answer never depends on server order.
 */
export function attachmentPathCandidates(schemaPaths: string[] | null): string[] {
  if (schemaPaths === null) return [];
  return schemaPaths
    .map((p) => p.trim())
    .filter((p) => /(^|\/)attachments?$/i.test(p))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * The single likeliest candidate, or null. Kept for the places that want one
 * name rather than the set; anything DECIDING something uses
 * `attachmentPathCandidates` and counts them.
 */
export function suggestAttachmentPath(schemaPaths: string[] | null): string | null {
  return attachmentPathCandidates(schemaPaths)[0] ?? null;
}

/**
 * The path to put in the box on the operator's behalf, or null for "leave it
 * exactly as it is".
 *
 * ASKED FOR BY THE OPERATOR: "Is there a way that we can have the system
 * populate that field based on the schema, similar to how we're able to get a
 * list of collections? That way, the user doesn't have to try to figure out
 * what it is and put it in manually." The machine can read the schema, so
 * nobody should be reverse-engineering an xpath out of a list of ~200.
 *
 * TWO CONDITIONS, AND BOTH MATTER.
 *
 *  - EXACTLY ONE CANDIDATE. Choosing between two would be this tool inventing
 *    an institution's answer, which is precisely what shipping
 *    `BYUI_extended/...` in code used to do. Several candidates are reported
 *    and left to the operator.
 *  - THE FIELD IS EMPTY. What the operator typed is the only evidence on this
 *    screen about what their site really uses, and a schema-derived guess must
 *    never overwrite it.
 *
 * PURE, AND ONLY EVER ASKED. It answers "may this be filled in", never "fill
 * it again" -- the caller decides when to ask, and asking on every render is
 * what would make a deliberately-cleared field impossible to keep clear. See
 * app.ts's `handleSetupCollectionChange`, which asks once per collection.
 */
export function attachmentPathToFill(
  schemaPaths: string[] | null,
  current: string,
): string | null {
  if (current.trim() !== '') return null;
  const candidates = attachmentPathCandidates(schemaPaths);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * Whether the attachment-uuid path the operator typed is a node the chosen
 * collection's schema actually has.
 *
 * The same lookup `core/preflight.ts`'s attachmentFieldCheck makes, said on
 * the screen where the value is entered rather than only in a pre-flight
 * report run from a terminal. This field is written on EVERY item the runner
 * creates, so a wrong path is a mistake repeated across a whole batch, and
 * openEQUELLA's response to metadata at an undeclared path does not explain
 * itself.
 *
 * BLANK IS NOT AN ERROR. It means "write no such field", and the message says
 * so instead of leaving an operator to infer it from silence.
 *
 * BUT THE CANDIDATE LEADS. Where the schema does declare one, that is named
 * first. The operator who reported this copy read "that is correct for most
 * schemas" and stopped there -- and theirs is the schema that declares the
 * field, so blank is the one silent data-loss path in this release.
 *
 * AND WHERE THERE IS NO CANDIDATE, SAY THAT. The old copy answered with a
 * reassurance about schemas in general; the same operator read it and replied
 * "I thought that the attachment-uuid was a requirement", which is the sound of
 * a general remark failing to answer a specific question. "This schema declares
 * no such field" is the honest form of the same reassurance, and it is about
 * the schema in front of them.
 *
 * SEVERAL CANDIDATES ARE NAMED AND NOT RANKED. Nothing is filled in, because
 * choosing between them would be an institution-specific assumption, and the
 * datalist on the box is already how the operator picks one.
 *
 * UNCHECKED IS NOT CORRECT. With no schema read, this says it could not check
 * -- the same rule every other check in this tool follows. "Could not check"
 * has never been reported as clean here and is not going to start.
 */
export function attachmentPathVerdict(
  path: string,
  schemaPaths: string[] | null,
  /** Whether this tool put the value there -- see SetupProps.attachmentPathFilled. */
  filled = false,
): AttachmentPathVerdict {
  const trimmed = path.trim();
  if (trimmed === '') {
    // BLANK AND UNCHECKED IS NOT BLANK AND FINE. Before a collection is
    // chosen there is no schema to look in, so "correct for most schemas" is a
    // reassurance about schemas in general offered to someone who has not been
    // told anything about theirs. That is how a real store ended up with this
    // empty: on the first pass through Setup -- which is the pass every
    // operator makes -- the field reads as settled when nothing has been
    // checked. Say what is and is not known, in that order.
    if (schemaPaths === null) {
      return {
        kind: 'blank',
        message:
          'Nothing will be recorded, and this has not been checked yet — no collection is ' +
          'chosen, so there is no schema to look in. Choose one above and this line will say ' +
          'whether it has such a field. Your files are attached either way.',
      };
    }
    const candidates = attachmentPathCandidates(schemaPaths);
    // NAMES NO PATH AT ALL when there is none to name: a guessed one would be
    // BYU-Idaho's answer at every other institution.
    if (candidates.length === 0) {
      return {
        kind: 'blank',
        message:
          'This collection’s schema declares no field for an attachment ID, so there is ' +
          'nothing to record and nothing to fill in here. Your files are attached either way.',
      };
    }
    if (candidates.length === 1) {
      return {
        kind: 'blank',
        message:
          `This collection’s schema declares ‘${candidates[0]}’, which is where an attachment ` +
          `ID is usually recorded. Choose it from the box above if that is the field your site ` +
          `uses. Left blank, nothing is recorded there — your files are attached either way.`,
      };
    }
    return {
      kind: 'blank',
      message:
        `This collection’s schema declares more than one field an attachment ID could go in — ` +
        `${candidates.map((c) => `‘${c}’`).join(', ')} — so none has been filled in for you. ` +
        `Choose the one your site uses from the box above, or leave this blank to record none ` +
        `of them. Your files are attached either way.`,
    };
  }
  if (schemaPaths === null) {
    return {
      kind: 'unchecked',
      message:
        'Not checked: choose a collection above and this is compared against ' +
        'the schema that collection actually uses.',
    };
  }
  if (schemaPaths.includes(trimmed)) {
    // SAY WHO PUT IT THERE. An operator who never typed this needs to know why
    // the box is not empty and that changing it is allowed; "Found in this
    // collection's schema" reads as a verdict on something they did.
    if (filled) {
      return {
        kind: 'filled',
        message:
          'Filled in for you from this collection’s schema, which declares this as its only ' +
          'field for an attachment ID. Every item created will record its attachment ID here. ' +
          'Change it or clear it if that is not what your site uses.',
      };
    }
    return {
      kind: 'declared',
      message: 'Found in this collection’s schema. Every item created will record its attachment ID here.',
    };
  }
  return {
    kind: 'undeclared',
    message:
      `Not declared by this collection’s schema (it has ${schemaPaths.length} valid paths). ` +
      'Every item created would record its attachment ID at a field the schema does not have. ' +
      'Correct it, or leave it blank.',
  };
}

/**
 * The sign-in half of the screen.
 *
 * Username and password comes FIRST, and is the default, because it is what
 * an institution can use on the day it installs this tool: an ordinary
 * openEQUELLA account, with nothing to request from an administrator. OAuth
 * lives behind an Advanced disclosure for the sites that need it -- BYU-Idaho
 * among them, where sign-in goes through SSO and a client ID and secret are
 * the only way in.
 *
 * Which one is used is an EXPLICIT choice, carried by `fields.authMode` and
 * stored as a discriminator (secrets.ts). It is never inferred from which
 * boxes happen to be filled in: a half-typed form would then quietly change
 * how the operator signs in.
 */
function authSection(props: SetupProps, forWhat: string): string {
  const f = props.fields;
  const account =
    props.storedUsername !== null
      ? `
        <div class="signed-in-card">
          <p>Signed in as <strong>${escapeHtml(props.storedUsername)}</strong></p>
          <div class="button-row">
            <button id="setup-forget-password" type="button" class="secondary">Forget this password</button>
          </div>
          <p class="note">
            Stored encrypted for your Windows account only.
            Another user on this PC cannot read it.
          </p>
        </div>`
      : `
        <label for="setup-username">Username (${forWhat})</label>
        <input
          id="setup-username"
          name="username"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.username)}"
        />

        <label for="setup-password">Password (${forWhat})</label>
        <input
          id="setup-password"
          name="password"
          type="password"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.password)}"
        />`;

  return `
      <fieldset class="auth-method">
        <legend>How you sign in</legend>

        <label class="radio-label" for="setup-auth-password">
          <input
            id="setup-auth-password"
            name="setup-auth-mode"
            type="radio"
            value="password"
            ${f.authMode === 'password' ? 'checked' : ''}
          />
          <span>Username and password</span>
        </label>
        ${f.authMode === 'password' ? account : ''}

        <details id="setup-advanced" ${f.authMode === 'code' ? 'open' : ''}>
          <summary>Advanced: OAuth client credentials</summary>
          <p class="hint">
            For sites behind single sign-on, where an ordinary password will not
            work. Your administrator issues the client ID and secret; they are
            <strong>not included with this program</strong>.
          </p>

          <label class="radio-label" for="setup-auth-code">
            <input
              id="setup-auth-code"
              name="setup-auth-mode"
              type="radio"
              value="code"
              ${f.authMode === 'code' ? 'checked' : ''}
            />
            <span>Use OAuth client credentials</span>
          </label>

          <label for="setup-client-id">Client ID (${forWhat})</label>
          <input
            id="setup-client-id"
            name="clientId"
            type="text"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(f.clientId)}"
          />

          <label for="setup-client-secret">Client secret (${forWhat})</label>
          <input
            id="setup-client-secret"
            name="clientSecret"
            type="password"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(f.clientSecret)}"
          />

          <label for="setup-redirect-uri">Redirect URL &mdash; must match exactly what is registered on the OAuth client, including or excluding a trailing slash.</label>
          <input
            id="setup-redirect-uri"
            name="redirectUri"
            type="text"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(f.redirectUri)}"
          />
        </details>
      </fieldset>`;
}

/**
 * The collections this account can contribute to, as a dropdown.
 *
 * A DROPDOWN AND NOT A UUID BOX. The list comes from
 * `GET /collection?privilege=CREATE_ITEM`, so it is exactly what this account
 * can create in; asking a non-technical operator to know a uuid instead
 * offers no way to notice a wrong one until items land in the wrong place.
 *
 * Every state it can be in says which state it is. Three of them are NOT
 * errors and must not look like one:
 *  - no site saved yet -- there is nobody to ask, so the section explains that
 *    this arrives after the credentials are saved;
 *  - still reading, or unreadable -- reported as unread, never as empty;
 *  - read, and EMPTY. An account that can create nothing is a real state (a
 *    viewer-only account looks exactly like this) with a real remedy that
 *    belongs to an administrator, not to this screen. An empty `<select>`
 *    would read as a broken app and send the operator looking in the wrong
 *    place entirely.
 *
 * ONLY THE DROPDOWN WAITS FOR A SAVED SITE. The attachment path and the
 * live-site flag below used to be inside the same early return, so neither was
 * on screen during the one Setup pass every operator definitely makes -- the
 * one where they add their site. Saving from that screen went straight on to
 * Sign-in, so unless somebody later found "Settings for {site}…", the live
 * flag was never a decision and the attachment path was never even mentioned.
 * Both were blank in the operator's real store. Neither needs the network and
 * neither needs a saved site, so neither waits for one.
 */
function collectionSection(props: SetupProps): string {
  const legend = '<legend>What this site is for</legend>';

  if (props.instanceId === '') {
    return `
      <fieldset class="site-settings">
        ${legend}
        <p class="hint">
          Save your sign-in details first. This tool then lists the collections
          your account can contribute to, and reads the schema they use.
        </p>
        ${attachmentSection(props)}
        ${liveSection(props)}
      </fieldset>`;
  }

  const body = ((): string => {
    if (props.collectionsError !== null) {
      return `<p class="error" role="alert">The list of collections could not be read: ${escapeHtml(props.collectionsError)}</p>`;
    }
    if (props.collectionsWithheld) {
      // Not the "you hold CREATE_ITEM on nothing" copy below: that one sends
      // the operator to an administrator, and this is their own sign-in.
      return `<p class="error" role="alert">${escapeHtml(WITHHELD_COLLECTIONS_MESSAGE)}</p>`;
    }
    if (props.collections === null) {
      return '<p class="muted">Reading the collections you can contribute to…</p>';
    }
    if (props.collections.length === 0) {
      return `
        <p class="note">
          This account holds <strong>CREATE_ITEM</strong> on no collection, so
          it can contribute nowhere and no upload can succeed. Sign-in itself
          worked, so this is a permission an openEQUELLA administrator grants —
          not a wrong address and not a wrong password.
        </p>`;
    }
    const options = [
      `<option value=""${props.fields.collectionUuid === '' ? ' selected' : ''}>Choose a collection…</option>`,
      ...props.collections.map(
        (c) =>
          `<option value="${escapeHtml(c.uuid)}"${c.uuid === props.fields.collectionUuid ? ' selected' : ''}>${escapeHtml(c.name)}</option>`,
      ),
    ].join('');
    return `
      <label for="setup-collection">Collection you contribute to</label>
      <select id="setup-collection">${options}</select>
      <p class="hint">
        Used to read that collection’s schema, so the field below can be
        checked for you. You still pick a collection for each batch later.
      </p>`;
  })();

  return `
      <fieldset class="site-settings">
        ${legend}
        ${body}
        ${attachmentSection(props)}
        ${liveSection(props)}
      </fieldset>`;
}

/**
 * The attachment-uuid path, with the schema's own paths offered as a datalist
 * and a verdict under the box.
 *
 * THIS IS A LIVE REGRESSION BEING FIXED, not a new nicety. `buildConfig` read
 * this from `OEQ_ATTACHMENT_UUID_PATH` in the process environment, which is
 * unset for an operator launching the packaged app from a Start Menu shortcut
 * -- so a BYU-Idaho operator using the GUI silently created items with no
 * `BYUI_extended/attachments/attachment` at all. No error, no warning, just
 * absent from every contribution.
 *
 * The datalist is the "offer" half: where the schema is known, the valid
 * xpaths are on the dropdown so the operator picks one instead of having to
 * know it. It does NOT restrict what can be typed -- a `<datalist>` suggests,
 * it does not constrain -- because a site whose schema could not be read must
 * still be able to enter the path they know is right. Where the schema leaves
 * no room for doubt -- exactly one candidate -- app.ts fills the box in on the
 * collection change, and the verdict says it did.
 *
 * NOTHING HERE FILLS ANYTHING IN. This function runs on every keystroke
 * anywhere on the screen; a fill made from a renderer would put a cleared path
 * straight back and no operator could ever record nothing on purpose.
 *
 * THE LABEL HAS TO SEPARATE TWO SENSES OF "ATTACHMENT". The file is attached
 * through openEQUELLA's attachment API on every item, whatever this box says;
 * only some schemas ALSO declare a metadata field recording that attachment's
 * ID, as an index for search and export. The operator who installed this read
 * the old label ("Field that holds the attachment ID") and concluded the
 * attachment itself depended on it.
 *
 * The placeholder is an INVENTED path (`local/attachments/attachment`), and
 * must stay invented. The datalist only helps someone who already knows the
 * shape they are looking for, and it is empty until a collection is chosen --
 * but a real `BYUI_extended/...` here would be an institution's answer shipped
 * to every other one, in the one place a placeholder reads as a default.
 */
/**
 * The standing caveat under the attachment field, shown whatever the verdict.
 *
 * WHY IT NAMES A PATH THIS TOOL WOULD REJECT. `item/attachments/attachment/uuid`
 * is what openEQUELLA's own sync documentation points at, and an operator who
 * has read that documentation will arrive expecting to type it here. They must
 * not: it is not in the schema -- checked against BYU-Idaho's, which declares
 * `item/attachments/attachment/type` and `.../attributes/entry/string` but no
 * `uuid` -- so this screen would tell them their own site's documented path is
 * undeclared, which reads as the tool being broken.
 *
 * It is not declared because nothing writes it. Two records settle that: an
 * item created by openEQUELLA's OWN contribution wizard carries
 * `BYUI_extended/attachments/attachment` with the uuid and an EMPTY `<item/>`,
 * and so does one created by this tool. Whatever representation sync reads
 * that path from, openEQUELLA generates it from the attachment records
 * themselves -- the file being attached is what populates it.
 *
 * So the note tells them where to look without telling them to type it, and
 * says the thing that actually resolves the question: match whatever your own
 * wizard produces.
 */
const SYNC_NOTE =
  'Some sites record the attachment ID at a different path. openEQUELLA also keeps its own ' +
  'attachment records, and a sync configuration may read ' +
  '‘item/attachments/attachment/uuid’ from those — that one is generated when the file is ' +
  'attached and needs nothing here. If you are unsure, contribute one item through ' +
  'openEQUELLA’s own web interface and match whatever it writes.';

function attachmentSection(props: SetupProps): string {
  const verdict = attachmentPathVerdict(
    props.fields.attachmentUuidPath,
    props.schemaPaths,
    props.attachmentPathFilled,
  );
  const list =
    props.schemaPaths === null
      ? ''
      : `<datalist id="setup-schema-paths">${props.schemaPaths
          .map((p) => `<option value="${escapeHtml(p)}"></option>`)
          .join('')}</datalist>`;

  return `
        <label for="setup-attachment-path">
          Field that records the attachment ID in the item’s metadata — your files are
          attached either way. Some schemas keep the ID as a field of their own so it can
          be searched and exported; if yours does, name that field here.
        </label>
        <input
          id="setup-attachment-path"
          name="attachmentUuidPath"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="e.g. local/attachments/attachment"
          ${props.schemaPaths === null ? '' : 'list="setup-schema-paths"'}
          value="${escapeHtml(props.fields.attachmentUuidPath)}"
        />
        ${list}
        <p class="hint verdict verdict--${verdict.kind}">${escapeHtml(verdict.message)}</p>
        <p class="hint">${escapeHtml(SYNC_NOTE)}</p>`;
}

/**
 * The live-site flag.
 *
 * CHECKED BY DEFAULT, and the copy says what that means. The instance banner
 * is the only durable cue telling an operator which site they are pointed at,
 * and it used to shout for every configured site -- which is the same as
 * shouting for none, since a warning seen daily on a sandbox is not seen at
 * all on the real thing. This is the one thing the app cannot work out for
 * itself and the operator can answer in one click.
 */
function liveSection(props: SetupProps): string {
  return `
        <label class="checkbox-label" for="setup-live">
          <input
            id="setup-live"
            name="live"
            type="checkbox"
            ${props.fields.live ? 'checked' : ''}
          />
          <span>This is a live site — items created here are real</span>
        </label>
        <p class="hint">
          Leave this ticked unless you know the address above is a test or
          training instance. When it is ticked the banner at the top stays
          loud, which is the only thing telling you which site you are
          uploading to.
        </p>`;
}

/**
 * The whole screen as markup, separated from `renderSetup` so it can be
 * asserted against as a string -- this project has no jsdom, and the existing
 * screen tests (ui/duplicates.ts and its test) read the markup a renderer
 * produces rather than a DOM it builds.
 */
export function setupMarkup(props: SetupProps): string {
  const selected = props.instances.find((i) => i.id === props.instanceId);

  const options = [
    ...props.instances.map(
      (i) =>
        `<option value="${escapeHtml(i.id)}"${i.id === props.instanceId ? ' selected' : ''}>${escapeHtml(i.label)}</option>`,
    ),
    `<option value=""${props.instanceId === '' ? ' selected' : ''}>Add another site…</option>`,
  ].join('');

  const forWhat = selected ? escapeHtml(selected.label) : 'this site';

  return `
    <section class="screen">
      <h1>Set up the Bulk Uploader</h1>
      ${setupNotice(props.credentialsDropped)}
      <p>
        Enter the address of your openEQUELLA site and how you sign in to it.
        Most institutions sign in with an ordinary openEQUELLA
        <strong>username and password</strong> &mdash; the same one you use on
        the site itself.
      </p>
      <p>
        Once saved, this is stored <strong>encrypted for this Windows user
        only</strong>, using Windows' own credential protection. No one else
        who logs into this computer can read it, and it never leaves this
        machine except to sign in to openEQUELLA.
      </p>

      ${
        props.instances.length > 0
          ? `<label for="setup-instance">These credentials are for</label>
      <select id="setup-instance">${options}</select>`
          : ''
      }

      <form id="setup-form" novalidate>
        <label for="setup-base-url">Site address &mdash; for example https://oeq.yourschool.edu</label>
        <input
          id="setup-base-url"
          name="baseUrl"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(props.fields.baseUrl)}"
        />

        <label for="setup-label">A name for it &mdash; whatever you call it, e.g. Production or Test</label>
        <input
          id="setup-label"
          name="label"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(props.fields.label)}"
        />

        ${authSection(props, forWhat)}

        ${collectionSection(props)}

        ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}

        <div class="button-row">
          ${
            props.returnTo === null
              ? ''
              : // type="button" is load-bearing: this sits INSIDE #setup-form,
                // and a default-type button in a form submits it -- which would
                // save, the one thing Back exists to avoid, failing in the most
                // expensive direction available.
                `<button id="setup-back" type="button" class="secondary">
            ${escapeHtml(backLabel(props.returnTo))}
          </button>`
          }
          <button type="submit" ${props.saving ? 'disabled' : ''}>
            ${props.saving ? 'Saving…' : 'Save credentials'}
          </button>
        </div>
        ${
          props.returnTo === null
            ? ''
            : `<p class="hint">
          Back leaves without saving: nothing you have typed here is kept, and
          nothing already saved is changed or removed.
        </p>`
        }
      </form>
    </section>
  `;
}

/**
 * The `Settings` this screen would save, assembled from what it actually
 * rendered.
 *
 * In password mode with an account already stored, the form shows "Signed in
 * as ..." and no password box at all, so it submits the stored username and an
 * EMPTY password -- which secrets.ts reads as "leave the stored password
 * alone". That is what lets the operator rename a site without being made to
 * type their password again, and it is why the only way to remove a password
 * is the Forget button.
 */
/**
 * The per-site record this screen would save: what the site IS, as opposed to
 * how it is signed in to (`settingsFrom` below).
 *
 * `schemaUuid` is taken from the chosen collection's own list entry rather
 * than fetched or typed -- `parseCollections` keeps `schema.uuid` on every
 * entry precisely so this costs no extra request. '' when no collection is
 * chosen, which is honest: nothing has been resolved.
 *
 * The attachment path is trimmed but NOT otherwise touched. Blank stays
 * blank: it means "write no such field", and coercing it into anything else
 * would write metadata the operator did not ask for onto every item in every
 * batch.
 */
export function instanceFrom(props: SetupProps): {
  label: string;
  baseUrl: string;
  attachmentUuidPath: string;
  live: boolean;
  schemaUuid: string;
} {
  const chosen = props.collections?.find((c) => c.uuid === props.fields.collectionUuid);
  return {
    label: props.fields.label.trim(),
    baseUrl: props.fields.baseUrl.trim(),
    attachmentUuidPath: props.fields.attachmentUuidPath.trim(),
    live: props.fields.live,
    schemaUuid: chosen?.schemaUuid ?? '',
  };
}

export function settingsFrom(props: SetupProps): Settings {
  const f = props.fields;
  if (f.authMode === 'password') {
    return {
      authMode: 'password',
      username: props.storedUsername ?? f.username.trim(),
      password: props.storedUsername !== null ? '' : f.password,
    };
  }
  return {
    authMode: 'code',
    clientId: f.clientId.trim(),
    clientSecret: f.clientSecret,
    redirectUri: f.redirectUri.trim(),
  };
}

/**
 * Credential-entry screen, scoped to ONE site at a time (see secrets.ts: each
 * openEQUELLA site has its own accounts and registers its own OAuth client, so
 * there is no single "the" credential). Reached on first run -- when the
 * operator has added no site at all -- or from Sign-in's "Add credentials"
 * prompt for whichever site turned out to have none.
 *
 * The address is typed here rather than picked from a list the app ships
 * with: this tool no longer knows any institution's addresses (ipc.ts). The
 * dropdown lists only what this operator has already added, plus the option
 * to add another.
 */
export function renderSetup(root: HTMLElement, props: SetupProps): void {
  // Every keystroke re-renders this screen (the fields are controlled -- see
  // SetupFields), which destroys and recreates the input being typed into.
  const restoreCaret = TEXT_INPUTS.map((selector) => keepCaret(root, selector));

  root.innerHTML = setupMarkup(props);

  for (const restore of restoreCaret) restore();

  root.querySelector<HTMLSelectElement>('#setup-instance')?.addEventListener('change', (e) => {
    props.onInstanceChange((e.target as HTMLSelectElement).value);
  });

  const field = (selector: string, name: SetupTextField): void => {
    root.querySelector<HTMLInputElement>(selector)?.addEventListener('input', (e) => {
      props.onFieldChange(name, (e.target as HTMLInputElement).value);
    });
  };
  field('#setup-base-url', 'baseUrl');
  field('#setup-label', 'label');
  field('#setup-username', 'username');
  field('#setup-password', 'password');
  field('#setup-client-id', 'clientId');
  field('#setup-client-secret', 'clientSecret');
  field('#setup-redirect-uri', 'redirectUri');
  field('#setup-attachment-path', 'attachmentUuidPath');

  root.querySelector<HTMLSelectElement>('#setup-collection')?.addEventListener('change', (e) => {
    props.onCollectionChange((e.target as HTMLSelectElement).value);
  });

  root.querySelector<HTMLInputElement>('#setup-live')?.addEventListener('change', (e) => {
    props.onLiveChange((e.target as HTMLInputElement).checked);
  });

  for (const [selector, mode] of [
    ['#setup-auth-password', 'password'],
    ['#setup-auth-code', 'code'],
  ] as const) {
    root.querySelector<HTMLInputElement>(selector)?.addEventListener('change', () => {
      props.onAuthModeChange(mode);
    });
  }

  root
    .querySelector<HTMLButtonElement>('#setup-forget-password')
    ?.addEventListener('click', () => props.onForgetPassword());

  root.querySelector<HTMLButtonElement>('#setup-back')?.addEventListener('click', () => props.onBack());

  root.querySelector<HTMLFormElement>('#setup-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    props.onSave(instanceFrom(props), settingsFrom(props));
  });
}
