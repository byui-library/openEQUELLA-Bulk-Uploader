import type { InstanceChoice, ModelChoice } from '../../ipc.js';
import type { CollectionSummary } from '../../../core/client.js';
// `import type`: secrets.ts reaches `node:fs`, and this module is rendered in
// the sandboxed renderer. A type-only import is erased at compile time and
// never becomes a runtime require -- see tests/desktop/rendererPurity.test.ts.
import type { ModelSettings, Settings, SettingsAuthMode } from '../../secrets.js';
import type { Screen } from '../state.js';
import { escapeHtml, keepCaret } from '../dom.js';
// A VALUE import, and it is safe: core/ai/provider.ts reaches only errors.ts,
// errorReason.ts, instanceUrl.ts, redact.ts and endpoint.ts, none of which
// touches `node:` or `electron`. tests/desktop/rendererPurity.test.ts walks
// this edge and fails the build if that ever stops being true.
import { MODEL_TIMEOUT_MS } from '../../../core/ai/provider.js';
import { MODEL_DEFAULTS } from '../../../core/ai/defaults.js';
// One rule for how a model address is shown, shared with the confirmation
// dialog so the two screens cannot name the same endpoint differently.
import { describeHost } from '../../../core/ai/endpoint.js';
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
  /**
   * The optional language-model endpoint, as typed.
   *
   * EVERY ONE OF THESE IS A STRING, INCLUDING THE THREE NUMBERS. They are text
   * boxes: what is in them mid-typing is `'80'` on the way to `'8000'`, and a
   * field held as a number cannot represent that, nor an empty box, nor `'lots'`.
   * `modelFrom` converts once, at the boundary, and hands anything unusable
   * through as NaN for core's own guards to refuse by name -- see its docblock.
   *
   * BLANK IS THE SHIPPED STATE AND MEANS NO MODEL AT ALL. Not "disabled": there
   * is nothing to disable, nothing is sent anywhere, and no other screen
   * mentions any of this.
   */
  modelBaseUrl: string;
  modelName: string;
  /** Never rendered back from the store. Same rule as the password. */
  modelKey: string;
  /** Characters to send from one document. */
  modelBudget: string;
  /** Most model requests one run may make. */
  modelCap: string;
  /** SECONDS, converted to milliseconds by `modelFrom`. Nobody types 120000. */
  modelTimeout: string;
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
   * The OAuth credential stored for this site, minus the secret, or null when
   * there is none.
   *
   * `hasSecret` rather than the secret itself, exactly as `storedUsername` is
   * rather than the password: this screen shows that one is stored and offers
   * to forget it, and never renders the value.
   */
  storedOAuth: { clientId: string; redirectUri: string; hasSecret: boolean } | null;
  /**
   * Where this build keeps its settings, or null while it is being read.
   *
   * SHOWN ONLY WHEN IT IS NOT THE ORDINARY CASE. A development run does not
   * share a store with the installed app -- Electron derives userData from the
   * app name, and a bare `electron dist-desktop/...` falls back to the default
   * one -- which is the right isolation and was invisible. It cost an
   * investigation: saves looked lost because the file being watched belonged
   * to the other copy.
   */
  storage: { path: string; appName: string; packaged: boolean } | null;
  /**
   * What the model endpoint last said it could run, or the reason it could
   * not be asked. Null before anyone has asked.
   *
   * ADVISORY. Nothing here gates a save: endpoints that serve completions
   * without a model list are common, and the typed name stays usable.
   */
  /**
   * Whether this site must be signed in to before its collections can be read.
   *
   * A STATEMENT, NOT AN ERROR. It is the ordinary state of an OAuth site that
   * has not been signed in to yet, and the operator has done nothing wrong.
   */
  needsSignIn: boolean;
  /** True while a sign-in started from this screen is in flight. */
  signingIn: boolean;
  /** Sign in to the site Setup is editing -- NOT the action flow's site. */
  onSignIn(): void;
  modelList: { models: string[] } | { error: string } | null;
  onListModels(): void;
  onForgetOAuth(): void;
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
  /**
   * The model endpoint already stored for this instance, or null when there is
   * none -- which is the shipped state and the overwhelmingly common one.
   *
   * WITHOUT THE KEY, exactly as `storedUsername` is without the password. The
   * screen needs two things from a stored endpoint: enough to say what is
   * configured, and the fact that there is something to forget. A key rendered
   * back into a box is a secret readable off the screen and copyable out of it,
   * bought for nothing.
   */
  storedModel: ModelChoice | null;
  /**
   * Whether the model disclosure is expanded.
   *
   * APP STATE, NOT THE DOM'S, and not derived from `storedModel` either. This
   * screen re-renders by replacing `innerHTML` on every keystroke, so anything
   * the operator did to a live element is destroyed and rebuilt from props --
   * which is the same reason every field on this screen is controlled. Derived
   * from what is stored, the section closed itself on the first character typed
   * into it, on the one path that can ever configure an endpoint, and took the
   * caret with it: `keepCaret`'s `focus()` cannot restore an input inside a
   * closed `<details>`.
   *
   * It is genuine two-way state rather than a latch, so closing it sticks too.
   * `app.ts` opens it once, when it finds an endpoint stored, and after that
   * the operator decides.
   */
  modelSectionOpen: boolean;
  error: string | null;
  saving: boolean;
  /**
   * The screen Setup was opened from, or null when there is nowhere to go back
   * to -- which is the case on first run, where Setup IS the launch screen, and
   * after "Clear all credentials…", which wipes every saved site and leaves a
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
   * "Clear all credentials…" and behind a confirm.
   */
  onBack(): void;
  onInstanceChange(id: string): void;
  onFieldChange(field: SetupTextField, value: string): void;
  onAuthModeChange(mode: SettingsAuthMode): void;
  onCollectionChange(uuid: string): void;
  onLiveChange(live: boolean): void;
  onForgetPassword(): void;
  /** Behind "Forget these model settings". Removes the endpoint and its key,
   *  and leaves the site and its credentials exactly where they are. */
  onForgetModel(): void;
  /** The operator expanded or collapsed the model disclosure. See
   *  `modelSectionOpen` -- without this the DOM is the only record of it, and
   *  the next render throws it away. */
  onModelSectionToggle(open: boolean): void;
  onSave(
    instance: {
      label: string;
      baseUrl: string;
      attachmentUuidPath: string;
      live: boolean;
      schemaUuid: string;
      collectionUuid: string;
    },
    settings: Settings,
    /**
     * What the model boxes amount to: nothing, something unusable, or an
     * endpoint. See `ModelEntry` -- the three are distinct because two of them
     * used to arrive here as the same `null`.
     *
     * `none` IS NOT "REMOVE IT". `refreshStoredModel` fails soft to null, so an
     * operator whose store could not be read submits this form with the model
     * boxes blank while an endpoint really is stored. Treating blank as a
     * deletion would throw away configuration they never touched, which is the
     * identical trap `saveInstance` avoids for a blank password. The only way to
     * remove an endpoint is `onForgetModel`.
     */
    model: ModelEntry,
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
  '#setup-model-base-url',
  '#setup-model-name',
  '#setup-model-key',
  '#setup-model-budget',
  '#setup-model-cap',
  '#setup-model-timeout',
] as const;

/**
 * What the model boxes start out holding.
 *
 * STARTING VALUES, NOT RULES. What a budget, a cap or a time limit may BE is
 * decided by `assertUsableBudget`, `assertUsableCap` and `assertUsableTimeout`
 * in `src/core/ai/`, and nothing here restates them -- these are only what is
 * pre-filled so an operator who types an address and a model name has a working
 * configuration without having to invent three numbers. Every one of them is
 * theirs to change, and the labels say what each is for.
 *
 * The address and the model name are deliberately NOT among them. Those two are
 * what turn the feature on, so guessing either would configure a model nobody
 * asked for -- and `http://localhost:11434/v1` pre-filled is a tool that looks
 * set up when nothing is listening.
 *
 * The time limit is `MODEL_TIMEOUT_MS` in seconds rather than a second copy of
 * the number: provider.ts argues that value out at length, and a form default
 * that quietly disagreed with the code's own would be the first thing to rot.
 */
export const MODEL_FIELD_DEFAULTS = {
  /** Characters from one document. A few thousand suits a local model; a page
   *  of prose is well under it, so most documents go whole. */
  budget: String(MODEL_DEFAULTS.budget),
  /** Requests per run. A ceiling on one batch, not a monthly allowance. */
  cap: String(MODEL_DEFAULTS.cap),
  timeout: String(Math.round(MODEL_TIMEOUT_MS / 1000)),
} as const;

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
/**
 * A development build says so, and says where its settings live.
 *
 * Empty for a packaged install: that is the ordinary case, and a notice that
 * fires on everything is one people stop reading.
 */
export function storageNote(storage: SetupProps['storage']): string {
  if (storage === null || storage.packaged) return '';
  return `
    <p class="hint">
      <strong>Development build.</strong> Its settings are kept separately from the
      installed app's, so sites and credentials saved here are not the ones the
      installed copy uses. Stored under
      <code>${escapeHtml(storage.path)}</code>.
    </p>`;
}

/**
 * What the endpoint answered when asked which models it offers.
 *
 * Three states, and they are different answers: nothing asked yet, asked and
 * told (possibly nothing at all -- reachable and empty is not the same as
 * unreachable), and asked and refused. The refusal is a hint rather than an
 * error box: it does not stop anything, because the name can still be typed.
 */
export function modelListNote(props: SetupProps): string {
  const list = props.modelList;
  if (list === null) return '';
  if ('error' in list) {
    return `<p class="hint">Could not ask that address which models it has: ${escapeHtml(list.error)}
      You can still type the name yourself.</p>`;
  }
  if (list.models.length === 0) {
    return `<p class="hint">That address answered, and has <strong>no models</strong> installed.</p>`;
  }
  return `
    <p class="hint">Models on that endpoint &mdash; click one to use it:</p>
    <div class="button-row">
      ${list.models
        .map(
          (m) =>
            `<button type="button" class="secondary model-choice" data-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`,
        )
        .join('')}
    </div>`;
}

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

          ${
            props.storedOAuth?.hasSecret === true
              ? `<div class="signed-in-card">
                   <p>Client secret <strong>stored</strong> for this site.</p>
                   <div class="button-row">
                     <button id="setup-forget-oauth" type="button" class="secondary">Forget these OAuth credentials</button>
                   </div>
                   <p class="note">
                     Stored encrypted for your Windows account only, and never shown again &mdash;
                     the same as a saved password. Leave this alone and it is kept as it is;
                     to replace it, forget it and enter a new one.
                   </p>
                 </div>`
              : `<label for="setup-client-secret">Client secret (${forWhat})</label>
                 <input
                   id="setup-client-secret"
                   name="clientSecret"
                   type="password"
                   autocomplete="off"
                   spellcheck="false"
                   value="${escapeHtml(f.clientSecret)}"
                 />`
          }

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
    // BEFORE the error branch, and phrased as a statement rather than a
    // failure: an OAuth site that has not been signed in to yet is an ordinary
    // state and the operator has done nothing wrong. They used to meet it as
    // "The list of collections could not be read: No cached OAuth token...",
    // which names the wrong thing and offers nothing to do about it.
    if (props.needsSignIn) {
      // The button, rather than directions to another screen: being told to go
      // back is worse than being able to act, and the operator is standing here.
      return `<div class="notice">
        <p><strong>Sign in to this site first.</strong> This site signs in with OAuth, so its
        list of collections is only available once you have signed in. A site that signs in
        with a username and password needs no such step.</p>
        <div class="button-row">
          <button id="setup-sign-in" type="button" ${props.signingIn ? 'disabled' : ''}>
            ${props.signingIn ? 'Signing in&hellip;' : 'Sign in to this site'}
          </button>
        </div>
      </div>
      ${
        // ALONGSIDE the offer, never instead of it. A refused token reaches this
        // branch with a real failure behind it, and the operator needs both the
        // reason and something they can do.
        props.collectionsError === null
          ? ''
          : `<p class="error" role="alert">The list of collections could not be read: ${escapeHtml(props.collectionsError)}</p>`
      }`;
    }
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
      <label for="setup-collection">Collection to read the schema from</label>
      <select id="setup-collection">${options}</select>
      <p class="hint">
        <strong>This is not where your files go.</strong> It names a collection whose
        schema describes your spreadsheet columns, so the field below can be checked
        and your columns validated later without signing in. You choose where each
        batch is uploaded on the next screen.
      </p>
      <p class="hint">
        Collections that share a schema only need setting up once — pick any one of
        them here, and upload to any of them later.
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
 * The optional language-model endpoint.
 *
 * ## Why this section is on screen at all, when the feature must not be
 *
 * The design is emphatic: "With no endpoint configured the feature does not
 * exist. No prompt, no error, no degraded mode, no mention on any screen." That
 * rule is about the FEATURE -- documents leaving the machine, a confirmation
 * dialog, a cell claiming a model wrote it. None of that happens until an
 * address is stored, and nothing anywhere else in the app changes.
 *
 * Setup is the one exception, and it has to be: this is the screen that creates
 * the configuration, and a settings screen which hides its own setting until
 * that setting exists can never be used to make one. So the compromise is
 * COLLAPSED, not hidden -- the same markup the Advanced OAuth disclosure uses.
 * `app.ts` opens it once, when it finds an endpoint stored, because at that
 * point it is describing a live setting the operator has a reason to look at.
 *
 * WHETHER IT IS OPEN COMES FROM PROPS, NEVER FROM WHAT IS STORED. Reading it
 * off `storedModel` is the same shape of mistake `keepCaret` exists for, one
 * level up: the operator's expansion lives only on the live element, and this
 * screen replaces `innerHTML` on every keystroke. See `modelSectionOpen`.
 *
 * ## The key box
 *
 * A stored key is NEVER rendered back into it -- the password rule, for the
 * password's reasons. The label says a local model needs none, because a box
 * asking for a key is an implicit claim that one is required, and the local
 * runtimes this feature exists to serve have no concept of one.
 */
/**
 * What the two boxes that turn the model on are CALLED on screen.
 *
 * Exported and interpolated into the labels rather than written twice, because
 * `modelEntryProblem` names the empty one back to the operator and a message
 * naming a box by a name the screen does not use sends them looking for a field
 * that is not there. Renaming a label now renames what the refusal says.
 *
 * Each label goes on to say more than this -- an example address, an example
 * model name -- and that trailing half is deliberately NOT part of the constant:
 * an error sentence carrying `<code>http://localhost:11434/v1</code>` inside it
 * would be escaped and read as markup.
 */
export const MODEL_ADDRESS_LABEL = 'Model address';
export const MODEL_NAME_LABEL = 'Model name at that address';

function modelSection(props: SetupProps): string {
  const f = props.fields;
  const stored = props.storedModel;

  const current =
    stored === null
      ? ''
      : `
          <div class="signed-in-card">
            <p>
              Using <strong>${escapeHtml(stored.model)}</strong> at
              <strong>${escapeHtml(describeHost(stored.baseUrl))}</strong>${
                stored.hasApiKey ? ' — an API key is stored for it' : ''
              }.
            </p>
            <div class="button-row">
              <button id="setup-model-forget" type="button" class="secondary">
                Forget these model settings
              </button>
            </div>
            <p class="note">
              Removing these leaves this site, its sign-in and everything else
              untouched — extraction simply goes back to filling those columns
              from the documents alone.
            </p>
          </div>`;

  return `
      <details id="setup-model" ${props.modelSectionOpen ? 'open' : ''}>
        <summary>Optional: let a language model fill gaps the documents do not answer</summary>
        <p class="hint">
          Leave this empty and nothing here applies: no model is contacted, nothing
          leaves this computer, and your spreadsheets are built exactly as they are
          today. Fill it in and a model may write <strong>only</strong> into columns a
          profile asked it to, and only where the extractor found nothing or already
          flagged its answer as a guess. Everything it writes is flagged for you to
          check.
        </p>
        ${current}

        <label for="setup-model-base-url">
          ${MODEL_ADDRESS_LABEL} — <code>http://localhost:11434/v1</code> for Ollama on this
          computer, or <code>https://api.openai.com/v1</code> for a hosted one
        </label>
        <input
          id="setup-model-base-url"
          name="modelBaseUrl"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="e.g. http://localhost:11434/v1"
          value="${escapeHtml(f.modelBaseUrl)}"
        />

        <label for="setup-model-name">${MODEL_NAME_LABEL} — for example <code>llama3.1:8b</code></label>
        <input
          id="setup-model-name"
          name="modelName"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.modelName)}"
        />
        <div class="button-row">
          <button id="setup-list-models" type="button" class="secondary">Show models on this endpoint</button>
        </div>
        ${modelListNote(props)}

        <label for="setup-model-key">
          API key — needed only for a <strong>hosted</strong> service that charges for
          use. A model running on this computer needs no key, so leave this empty.
        </label>
        <input
          id="setup-model-key"
          name="modelKey"
          type="password"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.modelKey)}"
        />
        <p class="hint">
          ${
            stored?.hasApiKey === true
              ? 'A key is stored for this site. Leave this empty to keep it, or type a new one to replace it.'
              : 'Stored encrypted for your Windows account only, exactly like your password.'
          }
        </p>

        <label for="setup-model-budget">
          Most characters to send from one document — a smaller model needs a
          smaller number. Longer documents are cut down to their opening and any
          headed sections.
        </label>
        <input
          id="setup-model-budget"
          name="modelBudget"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.modelBudget)}"
        />

        <label for="setup-model-cap">
          Most requests one run may make — the ceiling on what a single batch can
          cost. One request per column the model may fill, so a row with two such
          columns costs two. Anything past it is left blank and flagged.
        </label>
        <input
          id="setup-model-cap"
          name="modelCap"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.modelCap)}"
        />

        <label for="setup-model-timeout">
          Seconds to wait for one answer — raise this if a model on this computer
          is slow rather than broken. Ninety seconds is ordinary for a small model
          on an older machine.
        </label>
        <input
          id="setup-model-timeout"
          name="modelTimeout"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(f.modelTimeout)}"
        />
      </details>`;
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
        ${storageNote(props.storage)}
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

        ${modelSection(props)}

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
  collectionUuid: string;
} {
  const chosen = props.collections?.find((c) => c.uuid === props.fields.collectionUuid);
  return {
    label: props.fields.label.trim(),
    baseUrl: props.fields.baseUrl.trim(),
    attachmentUuidPath: props.fields.attachmentUuidPath.trim(),
    live: props.fields.live,
    schemaUuid: chosen?.schemaUuid ?? '',
    // Stored beside the schema so the screen can show WHICH collection it read
    // it from. Without it a saved setting looks exactly like a lost one.
    collectionUuid: props.fields.collectionUuid,
  };
}

/**
 * One typed number, or NaN.
 *
 * A BLANK BOX IS NaN AND NOT ZERO, which is the whole reason this exists rather
 * than a bare `Number()`. `Number('')` is 0, and 0 is a legitimate run cap
 * meaning "make no requests at all" -- so an operator who filled in an address
 * and left the cap box alone would configure a model that silently never runs,
 * with every row reporting that it hit a limit nobody set. NaN is refused,
 * loudly, by name.
 */
function typedNumber(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

/**
 * What the model boxes amount to. THREE ANSWERS, NOT TWO, and that is the whole
 * of this defect's fix.
 *
 * This function used to return `ModelSettings | null`, and `null` meant both
 * "the operator never touched this section" and "the operator typed into it but
 * left one of the two required boxes empty". `app.ts` stores nothing for a null
 * and then runs the ordinary success path -- so the second case reported a
 * successful save, discarded the typed model name, and said nothing anywhere.
 * The operator came back to Setup, found both boxes blank, and had no way to
 * learn that their input had ever existed. A step that could not run, reported
 * as though it had, is the failure this codebase has now had four times over
 * (CLAUDE.md: the duplicate check, the identifier check, `guest`, the cookie
 * jar); the fix each time is to make "could not" a value the caller must handle
 * rather than a shape it shares with "did".
 *
 *  - `none`  -- nothing was typed. The zero-prerequisite promise: `app.ts` stores
 *               nothing, removes nothing, says nothing, and no screen anywhere
 *               mentions a model. THIS MUST STAY EXACTLY AS IT IS.
 *  - `incomplete` -- something was typed and it cannot be called. Carries the
 *               sentence the operator is shown, naming the box that is empty.
 *  - `settings`   -- an endpoint, ready to store.
 *
 * `none` IS NOT "REMOVE THE STORED ONE" either -- see SetupProps.onSave.
 */
export type ModelEntry =
  | { kind: 'none' }
  | { kind: 'incomplete'; problem: string }
  | { kind: 'settings'; settings: ModelSettings };

/**
 * Why the model boxes cannot be turned into an endpoint, or null when there is
 * no problem to report -- which covers BOTH a complete endpoint and an
 * untouched section.
 *
 * WHAT COUNTS AS "TOUCHED" IS THE ONLY DELICATE PART. The three numbers arrive
 * pre-filled (`MODEL_FIELD_DEFAULTS`), so they cannot be evidence of anything:
 * reading them as "the operator started configuring a model" would fire this
 * refusal on every fresh form, which is precisely the "no change whatsoever"
 * property this must not break. Only the two boxes that turn the feature on --
 * and the key, which nobody types by accident and which is otherwise about to be
 * thrown away in silence -- are treated as intent.
 *
 * PURE AND EXPORTED so the wording is asserted directly; this project has no
 * jsdom and its screen tests read what a renderer returns.
 */
export function modelEntryProblem(fields: SetupFields): string | null {
  const baseUrl = fields.modelBaseUrl.trim();
  const model = fields.modelName.trim();
  const key = fields.modelKey.trim();
  // Untouched. Nothing to say, and saying anything here is the defect.
  if (baseUrl === '' && model === '' && key === '') return null;
  // Callable. The numbers are core's business, not this function's.
  if (baseUrl !== '' && model !== '') return null;
  const missing = [
    baseUrl === '' ? `‘${MODEL_ADDRESS_LABEL}’` : null,
    model === '' ? `‘${MODEL_NAME_LABEL}’` : null,
  ].filter((label): label is string => label !== null);
  const [one] = missing;
  return (
    'Nothing has been saved. The model settings need both an address and a model name, and ' +
    (missing.length === 1
      ? `${one} is still empty. Fill it in`
      : `${missing.join(' and ')} are still empty. Fill them in`) +
    ', or empty the model section entirely to leave the model settings switched off.'
  );
}

/**
 * The model endpoint this screen would store, or why it cannot be, or nothing.
 *
 * NOTHING IS VALIDATED HERE BEYOND "ARE BOTH BOXES FILLED IN", DELIBERATELY. The
 * rules about what a budget, a cap and a time limit may be belong to
 * `assertUsableBudget` (core/ai/slice.ts), `assertUsableCap` (core/ai/fill.ts)
 * and `assertUsableTimeout` (core/ai/provider.ts) -- the code that actually runs
 * with these numbers -- and `secrets.ts#setModel` calls those three on the way
 * in. A copy of them here would be a second opinion free to drift from the
 * first, and the shape of failure that produces is the worst one available: a
 * value this screen accepts and the run then refuses, hundreds of rows later, by
 * a message about a text box the operator closed an hour ago. So a mistyped
 * number passes through as NaN and comes straight back as an error on this
 * screen, in core's own words.
 *
 * The emptiness of the two required boxes is the one thing that CANNOT be
 * delegated that way, because with either of them blank there is no call to
 * make and so nothing downstream is ever asked. That is why it is checked here
 * and nowhere else.
 *
 * The time limit is the one conversion: SECONDS on screen, milliseconds in
 * `ProviderConfig`. Nobody types 120000, and nothing downstream thinks in
 * seconds.
 */
export function modelFrom(props: SetupProps): ModelEntry {
  const f = props.fields;
  const baseUrl = f.modelBaseUrl.trim();
  const model = f.modelName.trim();
  const problem = modelEntryProblem(f);
  if (problem !== null) return { kind: 'incomplete', problem };
  if (baseUrl === '' || model === '') return { kind: 'none' };
  return {
    kind: 'settings',
    settings: {
      baseUrl,
      model,
      // Blank means "keep whatever is stored for this endpoint" -- resolved in
      // secrets.ts#setModel, which is the only place that can see the stored one.
      apiKey: f.modelKey,
      budget: typedNumber(f.modelBudget),
      cap: typedNumber(f.modelCap),
      timeoutMs: typedNumber(f.modelTimeout) * 1000,
    },
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
  root.querySelector<HTMLButtonElement>('#setup-sign-in')?.addEventListener('click', () => {
    props.onSignIn();
  });
  root.querySelector<HTMLButtonElement>('#setup-forget-oauth')?.addEventListener('click', () => {
    props.onForgetOAuth();
  });
  root.querySelector<HTMLButtonElement>('#setup-list-models')?.addEventListener('click', () => {
    props.onListModels();
  });
  root.querySelectorAll<HTMLButtonElement>('.model-choice').forEach((b) => {
    b.addEventListener('click', () => {
      props.onFieldChange('modelName', b.dataset['model'] ?? '');
    });
  });
  field('#setup-client-id', 'clientId');
  field('#setup-client-secret', 'clientSecret');
  field('#setup-redirect-uri', 'redirectUri');
  field('#setup-attachment-path', 'attachmentUuidPath');
  field('#setup-model-base-url', 'modelBaseUrl');
  field('#setup-model-name', 'modelName');
  field('#setup-model-key', 'modelKey');
  field('#setup-model-budget', 'modelBudget');
  field('#setup-model-cap', 'modelCap');
  field('#setup-model-timeout', 'modelTimeout');

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

  root
    .querySelector<HTMLButtonElement>('#setup-model-forget')
    ?.addEventListener('click', () => props.onForgetModel());

  // The ONLY record of the operator having opened this is the live element,
  // and the next keystroke replaces it. Handing it back to app.ts is what
  // survives the re-render -- see SetupProps.modelSectionOpen.
  root.querySelector<HTMLDetailsElement>('#setup-model')?.addEventListener('toggle', (e) => {
    props.onModelSectionToggle((e.target as HTMLDetailsElement).open);
  });

  root.querySelector<HTMLButtonElement>('#setup-back')?.addEventListener('click', () => props.onBack());

  root.querySelector<HTMLFormElement>('#setup-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    props.onSave(instanceFrom(props), settingsFrom(props), modelFrom(props));
  });
}
