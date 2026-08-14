import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { unlinkSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoredToken, TokenStore } from '../core/tokenStore.js';
import { instanceKey, normaliseInstanceUrl } from '../core/instanceUrl.js';
// The ONE copy of each rule about what these numbers may be. See `setModel`.
import { assertUsableBudget } from '../core/ai/slice.js';
import { assertUsableCap } from '../core/ai/fill.js';
import { assertUsableTimeout, MODEL_TIMEOUT_MS } from '../core/ai/provider.js';
import { ValidationError } from '../core/errors.js';

/**
 * The subset of Electron's `safeStorage` this module needs, extracted as an
 * interface so tests can substitute a fake. On Windows the real
 * implementation encrypts via DPAPI -- the same OS mechanism that backs
 * Credential Manager -- scoped to the logged-in user.
 */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

/**
 * How the operator signs in to one instance.
 *
 * A DISCRIMINATOR, not an inference from which fields happen to be filled in.
 * "Empty client id means they must have meant password" is a rule that has to
 * be re-derived correctly at every site that reads these settings, and is
 * wrong the first time somebody saves a half-typed form; an explicit mode is
 * read the same way everywhere and survives a partly filled form intact.
 *
 * A subset of core's `AuthMode` (core/config.ts): `client_credentials` is
 * deliberately absent, because it is an unattended-run mode with no operator
 * at the keyboard and Setup has nothing to collect for it that it does not
 * already collect for `code`.
 */
export type SettingsAuthMode = 'code' | 'password';

/** OAuth authorization-code credentials -- the SSO-backed sites' route in. */
export interface OAuthSettings {
  authMode: 'code';
  clientId: string;
  clientSecret: string;
  /**
   * Registered on the OAuth client by an administrator and NOT derivable
   * from the instance's base url -- production has no trailing slash, one
   * test client had one, another dedicated test client does not. This exact
   * value has been guessed wrong TWICE in this project by hard-coding it
   * (see ipc.ts's INSTANCES doc comment), so it is now stored configuration,
   * collected in Setup and sent to openEQUELLA verbatim, never re-derived.
   */
  redirectUri: string;
}

/**
 * An ordinary openEQUELLA account: what an institution that is not behind SSO
 * can use on the day it installs this tool, with nothing to request from an
 * administrator first.
 *
 * The password is here because `buildConfig` (session.ts) needs it to reach
 * `UsernamePasswordAuth`. On disk it lives apart from the instance entry, in
 * its own per-instance record, so `forgetPassword` can remove the credential
 * without removing the site -- see `StoredShapeV3`.
 */
export interface PasswordSettings {
  authMode: 'password';
  username: string;
  /** Never logged, never written to a manifest. See core/config.ts. */
  password: string;
}

export type Settings = OAuthSettings | PasswordSettings;

/**
 * The language-model endpoint one site's extractions may use, as stored.
 *
 * ABSENT IS THE DEFAULT AND ABSENT MEANS THE FEATURE DOES NOT EXIST. There is
 * no "disabled" flag and no partially-configured state: `getModel` answers null
 * and every surface reads that as "no model", which is what lets this tool be
 * adopted without a data review. Nothing ships configured.
 *
 * PER INSTANCE, and stored in the `models` map beside `passwords` rather than
 * inside the instance entry, for exactly the reason the passwords are: "forget
 * these model settings" has to remove the endpoint while leaving the site, its
 * name, its address and its credentials alone.
 *
 * The three numbers are the operator's, and every one of them is validated
 * against core's own rule rather than a copy -- see `setModel`.
 */
export interface ModelSettings {
  /** Base URL up to and including /v1. Ollama, LM Studio, OpenAI, Azure. */
  baseUrl: string;
  /** The model's name AT THAT ENDPOINT (`llama3`, `gpt-4o-mini`). */
  model: string;
  /**
   * Empty for a local runtime, which needs no key. Encrypted with everything
   * else in this file, and never rendered back into a field -- see
   * `ModelChoice` in ipc.ts, which is what the renderer is actually given.
   */
  apiKey: string;
  /** Characters to send from ONE document. See core/ai/slice.ts. */
  budget: number;
  /** Most REQUESTS one run may make -- not rows. See core/ai/fill.ts. */
  cap: number;
  /**
   * Milliseconds to wait for one completion.
   *
   * STORED RATHER THAN FIXED because the timeout message tells the operator to
   * "allow more time, or use a smaller model", and without this field the first
   * half of that sentence names an action the app does not offer. A quantised
   * model on an old CPU is the configuration this whole feature exists to
   * serve, and it is the one that legitimately exceeds any default.
   */
  timeoutMs: number;
}

/**
 * The key one instance's credentials are stored under: `instanceKey` of its
 * address (core/instanceUrl.ts). A plain string, not a union of known names
 * -- the instances are the operator's own, added on Setup, and this tool
 * ships knowing none of them.
 */
export type InstanceId = string;

/**
 * An openEQUELLA site the operator has added, as everything outside this
 * module sees it.
 *
 * Everything here is per-INSTANCE and not per-credential, which is why it sits
 * beside `Settings` rather than inside it: an institution's schema, its
 * production-or-not status and its site address are facts about the SITE, true
 * whether it is reached with a password or with an OAuth client.
 */
export interface Instance {
  id: InstanceId;
  /** What the operator calls it. Defaults to the address's host. */
  label: string;
  /** Normalised (`normaliseInstanceUrl`), so it can be concatenated with an api path. */
  baseUrl: string;
  /** How this site signs in. Mirrors `Settings.authMode`; carries no secret. */
  authMode: SettingsAuthMode;
  /**
   * Where each item's attachment uuid is written into its metadata, as a
   * spreadsheet-style xpath (`BYUI_extended/attachments/attachment`), or ''
   * for "write no such field".
   *
   * STORED, not read from `process.env`. `session.ts`'s `buildConfig` used to
   * take it from `OEQ_ATTACHMENT_UUID_PATH`, which works for a developer
   * running `npm run desktop` and is useless for an operator launching the
   * packaged app from a Start Menu shortcut with no environment set -- their
   * items came out silently missing the field, with no error and nothing to
   * notice until somebody went looking in openEQUELLA weeks later.
   *
   * BLANK IS A LEGITIMATE CHOICE and the right default for most institutions,
   * whose schema declares no such node. It is never coerced into a guess.
   */
  attachmentUuidPath: string;
  /**
   * Whether this is a live site -- one where a contribution is a real,
   * undoable item in a real collection. Drives the instance banner
   * (ui/banner.ts).
   *
   * DEFAULTS TO TRUE, including for an entry written before this field
   * existed. A new site is assumed live until the operator says otherwise, so
   * the failure direction stays safe: being warned about a sandbox is a
   * nuisance, not being warned about production is an unrecoverable batch.
   */
  live: boolean;
  /**
   * The schema of the collection the operator picked on Setup, or '' if none
   * has been picked.
   *
   * Stored because it is the ADDRESS OF THE CACHED SCHEMA: `SchemaCache`
   * (core/schemaCache.ts) is keyed on (instance url, schema uuid), and
   * extraction -- which never touches the network -- has no other way to find
   * the schema it should validate its columns against. Derived from the chosen
   * collection's own `schema.uuid` (discovery.ts#parseCollections), never
   * typed by the operator.
   */
  schemaUuid: string;
}

/**
 * On-disk shape for one instance's entry. Every field its OWN mode needs is
 * required: an entry missing one is not a usable credential, and filling the
 * gap in would mean inventing a value -- see `OAuthSettings.redirectUri` for
 * what inventing that one in particular has cost this project. Which fields
 * those are depends on `authMode`, so a password entry is not rejected for
 * having no client id it was never going to have.
 *
 * The password itself is NOT here: it lives in `StoredShapeV3.passwords`.
 */
type StoredEntry = {
  label: string;
  baseUrl: string;
  attachmentUuidPath: string;
  live: boolean;
  schemaUuid: string;
} & (
  | { authMode: 'code'; clientId: string; clientSecret: string; redirectUri: string }
  | { authMode: 'password' }
);

/** One instance's openEQUELLA account, as stored. */
interface StoredPassword {
  username: string;
  password: string;
}

/**
 * On-disk shape written by THIS version of the store.
 *
 * `passwords` is keyed exactly like `instances` and kept beside them rather
 * than inside them for two reasons: "Forget this password" has to be able to
 * remove the credential while leaving the site, its name and its address
 * alone; and a v3 file written before password auth existed simply has no
 * `passwords` key, which reads as "no passwords stored" with no migration at
 * all. Still ONE file and ONE `safeStorage` encryption -- a second store
 * would be a second thing to keep in step and a second thing to leave behind
 * on `clear()`.
 */
interface StoredShapeV3 {
  version: 3;
  instances: Record<InstanceId, StoredEntry>;
  passwords: Record<InstanceId, StoredPassword>;
  /**
   * PURELY ADDITIVE, AND THE VERSION DELIBERATELY DID NOT CHANGE FOR IT.
   *
   * A v3 file written before model settings existed simply has no `models`
   * key, which `loadAll` reads as "no model configured" with no migration step
   * -- exactly as `passwords` was added. Bumping the version, or requiring this
   * key, would send every stored credential through the "unrecognised shape ->
   * empty" path a SECOND time; the operator has not yet told staff about the
   * first one, and the Setup notice explaining a blank form would be explaining
   * the wrong event.
   */
  models: Record<InstanceId, ModelSettings>;
}

/**
 * What `loadAll` returns: the store, plus whether readable credentials
 * written by an older version were found and thrown away. Setup needs that
 * second fact to explain an otherwise blank form -- see `credentialsDropped`.
 */
interface LoadResult {
  shape: StoredShapeV3;
  dropped: boolean;
}

/**
 * One on-disk entry, normalised -- or null if it is not a usable credential.
 *
 * A parse rather than a type guard because of the one thing it fills in: an
 * entry with NO `authMode` is a v3 entry written by this same branch before
 * password auth existed, and every one of those is an OAuth entry. Reading it
 * as `code` is not a guess -- `code` was the only mode the desktop could
 * produce, hardcoded in `buildConfig`. Discarding it over a field that had not
 * been invented yet would send an operator back to their administrator for a
 * client secret for no reason at all.
 *
 * The three per-site settings are defaulted rather than required, for the same
 * reason: an entry written before they existed is a perfectly good credential,
 * and none of them is a secret that has to come from the operator.
 * `attachmentUuidPath` and `schemaUuid` default to '' -- "no such field" and
 * "no schema picked", both true of an entry that predates them. `live`
 * defaults to TRUE: an unmarked site is assumed live, because the direction to
 * be wrong in is warning about a sandbox, not staying quiet about production.
 *
 * Nothing else is filled in. A `code` entry still has to carry all three OAuth
 * fields, and one missing its `redirectUri` is still dropped rather than
 * having one derived for it.
 */
function parseStoredEntry(v: unknown): StoredEntry | null {
  const e = v as Record<string, unknown> | null;
  if (typeof e !== 'object' || e === null) return null;
  if (typeof e.label !== 'string' || typeof e.baseUrl !== 'string') return null;
  const base = {
    label: e.label,
    baseUrl: e.baseUrl,
    attachmentUuidPath: typeof e.attachmentUuidPath === 'string' ? e.attachmentUuidPath : '',
    live: typeof e.live === 'boolean' ? e.live : true,
    schemaUuid: typeof e.schemaUuid === 'string' ? e.schemaUuid : '',
  };

  if (e.authMode === 'password') return { ...base, authMode: 'password' };
  if (e.authMode !== undefined && e.authMode !== 'code') return null;
  if (
    typeof e.clientId !== 'string' ||
    typeof e.clientSecret !== 'string' ||
    typeof e.redirectUri !== 'string'
  ) {
    return null;
  }
  return {
    ...base,
    authMode: 'code',
    clientId: e.clientId,
    clientSecret: e.clientSecret,
    redirectUri: e.redirectUri,
  };
}

/**
 * One stored entry as everything outside this module sees it. Deliberately
 * field-by-field rather than a spread of `stored`: `StoredEntry` also carries
 * the client id and secret in OAuth mode, and this is the shape handed to the
 * sandboxed renderer through `listInstances` (ipc.ts's `InstanceChoice`). A
 * spread would put an OAuth client secret in the renderer the day a field was
 * added to `StoredEntry`, silently.
 */
function toInstance(id: InstanceId, stored: StoredEntry): Instance {
  return {
    id,
    label: stored.label,
    baseUrl: stored.baseUrl,
    // Always set: parseStoredEntry fills 'code' in for an entry written
    // before the discriminator existed, rather than leaving it absent.
    authMode: stored.authMode,
    attachmentUuidPath: stored.attachmentUuidPath,
    live: stored.live,
    schemaUuid: stored.schemaUuid,
  };
}

/** One stored account, or null. Both halves or neither -- a password with no
 *  username signs nobody in, and a username alone is not a credential. */
function parseStoredPassword(v: unknown): StoredPassword | null {
  const p = v as Record<string, unknown> | null;
  if (typeof p !== 'object' || p === null) return null;
  if (typeof p.username !== 'string' || typeof p.password !== 'string') return null;
  return { username: p.username, password: p.password };
}

/**
 * What a usable model endpoint IS. Throws, naming the setting, when it is not.
 *
 * ONE RULE, ASKED BY BOTH SIDES. `setModel` calls it to refuse a write; the
 * loader below calls it to discard an entry. They used to disagree: the loader
 * checked `typeof === 'number'` only, so a hand-edited `budget: 0`, `cap: -1`
 * or `budget: 1e999` loaded perfectly happily -- every one of them a value the
 * write side refuses, and `budget: 0` in particular a value that makes every
 * row in a batch report "no text to read" about files that are full of text.
 * That is the second opinion this codebase spends its comments arguing against,
 * sitting inside the module that argues it.
 *
 * AN ADDRESS AND A MODEL NAME OR NOTHING. Half an endpoint cannot be called,
 * and reporting it as configured would put a confirmation dialog in front of
 * the operator for a run that can only fail on every row. Same rule as a
 * password with no username: both halves, or neither. This is also why the
 * write side asks -- `setModel` used to accept a blank address and resolve
 * successfully, and the entry then read back as `null`: a write reported as
 * done that did nothing, which is this codebase's oldest shape of defect.
 *
 * The three numbers are core's own rules, called rather than restated -- see
 * `setModel`.
 */
function assertUsableModel(settings: ModelSettings): void {
  if (settings.baseUrl.trim() === '') {
    throw new ValidationError(
      'A model endpoint needs an address, such as http://localhost:11434/v1 for a model ' +
        'running on this computer. Leave both it and the model name empty to configure no model at all.',
    );
  }
  if (settings.model.trim() === '') {
    throw new ValidationError(
      `A model endpoint needs the name of a model at that address, such as 'llama3'. ` +
        'Leave both it and the address empty to configure no model at all.',
    );
  }
  assertUsableBudget(settings.budget);
  assertUsableCap(settings.cap);
  assertUsableTimeout(settings.timeoutMs);
}

/**
 * One stored model endpoint, or null when it is not a usable one.
 *
 * THE SAME RULE THE WRITE SIDE ENFORCES, asked here in the only way a loader
 * can ask it: by catching. "Unusable" now means one thing in this module
 * instead of two, so an entry that could never be run is discarded on the way
 * out rather than being handed to a confirmation dialog and a fill pass that
 * then refuse it.
 *
 * DISCARDING IS THE SAFE DIRECTION. A discarded endpoint is "no model
 * configured", which is the shipped state and costs the operator nothing but
 * re-entering it; a loaded-but-unusable one is a batch that looks configured
 * and fails on every row.
 *
 * `timeoutMs` is defaulted when ABSENT -- an entry written before the field
 * existed keeps working, the same courtesy `live` gets above. It is not
 * defaulted when present and wrong; that is a value somebody chose.
 */
function parseStoredModel(v: unknown): ModelSettings | null {
  const m = v as Record<string, unknown> | null;
  if (typeof m !== 'object' || m === null) return null;
  if (typeof m.baseUrl !== 'string') return null;
  if (typeof m.model !== 'string') return null;
  if (typeof m.apiKey !== 'string') return null;
  if (typeof m.budget !== 'number' || typeof m.cap !== 'number') return null;
  if (m.timeoutMs !== undefined && typeof m.timeoutMs !== 'number') return null;
  const settings: ModelSettings = {
    baseUrl: m.baseUrl,
    model: m.model,
    apiKey: m.apiKey,
    budget: m.budget,
    cap: m.cap,
    timeoutMs: typeof m.timeoutMs === 'number' ? m.timeoutMs : MODEL_TIMEOUT_MS,
  };
  try {
    assertUsableModel(settings);
  } catch {
    return null;
  }
  return settings;
}

/**
 * Whether two model addresses are served by the same place, for deciding
 * whether a key stored for one may be kept for the other.
 *
 * ORIGIN, NOT THE WHOLE URL: scheme, host and port are who the key is being
 * handed to, and changing `/v1` to `/v1beta` on the same gateway is not a
 * different service. FALSE FOR ANYTHING THAT WILL NOT PARSE, because every
 * caller reads this as "is it safe to keep the key", and the unknown case has
 * to be the one that drops it.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Credentials are per instance: each openEQUELLA site registers its own OAuth
 * client, so a client ID that works on one is refused outright by another. A
 * site's entry is keyed by `instanceKey` of its address, which is what makes
 * two spellings of one address a single entry rather than two. Earlier
 * versions of this store persisted a single, unkeyed `{clientId,
 * clientSecret}` pair -- fine when the app only ever talked to one site,
 * wrong now that the operator can add any number of them.
 *
 * Migration: a store written by an older format cannot be rekeyed. `version:
 * 2` keyed entries by the literal names 'production' and 'test' -- two
 * addresses the app itself used to declare and no longer does -- and the
 * older flat format never recorded which site its pair belonged to at all.
 * Guessing would risk silently handing one site's client_id to another, which
 * is precisely the bug this store exists to prevent. So `loadAll` treats ANY
 * on-disk shape that isn't this version's `{version: 3, instances: {...}}`
 * wrapper -- v2, the old flat shape, a corrupt blob, or anything else
 * unrecognised -- as "no credentials saved at all". The operator sees Setup
 * again and re-enters what they have; that one-time re-prompt is a far
 * smaller cost than a wrong-instance credential being sent to openEQUELLA
 * unnoticed.
 *
 * A discard that happened silently would read as a broken app, so it is
 * reported: see `credentialsDropped`, and the notice Setup shows because of it.
 */
export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  /**
   * Add or update one instance and its credentials, returning the instance as
   * stored -- including the id, which is DERIVED here rather than supplied,
   * so there is exactly one rule for what an address's key is.
   *
   * A blank label falls back to the address's host: a dropdown of untitled
   * entries is no way to tell a live site from a sandbox, and the host is the
   * one name that is always available and always true.
   *
   * The three per-site settings are OPTIONAL on the way in, and an omitted one
   * leaves whatever is already stored alone -- the same rule as a blank
   * password below. A caller that only means to rename a site must not silently
   * reset which field its attachment uuids are written to, or un-mark it as
   * live. Explicitly passing `''` for `attachmentUuidPath` is NOT an omission:
   * blank means "write no such field", which is a real choice and the correct
   * one for most schemas, so it is stored as given.
   */
  async saveInstance(
    instance: {
      label: string;
      baseUrl: string;
      attachmentUuidPath?: string;
      live?: boolean;
      schemaUuid?: string;
    },
    settings: Settings,
  ): Promise<Instance> {
    this.requireEncryption();
    // Before anything is written: an address that cannot be normalised has no
    // key, and https is required (see normaliseInstanceUrl).
    const baseUrl = normaliseInstanceUrl(instance.baseUrl);
    const id = instanceKey(baseUrl);
    const label = instance.label.trim() || new URL(baseUrl).host;

    const { shape } = await this.loadAll();
    const previous = shape.instances[id];
    const site = {
      label,
      baseUrl,
      attachmentUuidPath: instance.attachmentUuidPath ?? previous?.attachmentUuidPath ?? '',
      // `true` last, not `previous?.live ?? true` folded into one `??` chain
      // with an explicit `false`: `false ?? true` is `false`, but reading it
      // that way takes a moment, and "assumed live" is the rule this defaults
      // to when nothing at all is known.
      live: instance.live ?? previous?.live ?? true,
      schemaUuid: instance.schemaUuid ?? previous?.schemaUuid ?? '',
    };
    if (settings.authMode === 'password') {
      shape.instances[id] = { ...site, authMode: 'password' };
      // A BLANK password means "leave the stored one alone", not "clear it".
      // Setup never renders a stored password back into a field, so the form
      // submitted by an operator who only renamed the site carries an empty
      // one; treating that as a deletion would sign them out of a site they
      // never touched. The only way to remove a password is forgetPassword.
      if (settings.password !== '') {
        shape.passwords[id] = { username: settings.username, password: settings.password };
      }
    } else {
      const { authMode, clientId, clientSecret, redirectUri } = settings;
      shape.instances[id] = { ...site, authMode, clientId, clientSecret, redirectUri };
      // Any password stored for this site is left where it is: switching to
      // Advanced to correct a client id must not throw away a credential the
      // operator can only replace by typing it again.
    }
    await this.write(shape);
    return { id, authMode: settings.authMode, ...site };
  }

  /**
   * The instance's credentials in the shape `buildConfig` consumes, or null
   * when there is no usable one.
   *
   * Null for a password-mode instance whose password has been forgotten: it
   * is a site with no credential, and reporting it as configured would put a
   * "Sign in" button in front of the operator that can only fail with an empty
   * password. `handlers.ts` turns the null into "no credentials saved for
   * {site}", which is both true and actionable.
   */
  async loadSettings(instanceId: InstanceId): Promise<Settings | null> {
    const { shape } = await this.loadAll();
    const stored = shape.instances[instanceId];
    if (!stored) return null;
    if (stored.authMode === 'password') {
      const account = shape.passwords[instanceId];
      if (!account) return null;
      return { authMode: 'password', username: account.username, password: account.password };
    }
    return {
      authMode: 'code',
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      // Verbatim, never re-derived. See OAuthSettings.redirectUri.
      redirectUri: stored.redirectUri,
    };
  }

  /**
   * Store one instance's openEQUELLA account. Same encryption and the same
   * per-instance key as the client secret: an account that works on one site
   * is refused outright by another, so there is no such thing as "the"
   * password any more than there is "the" client id.
   */
  async setPassword(instanceId: InstanceId, username: string, password: string): Promise<void> {
    this.requireEncryption();
    const { shape } = await this.loadAll();
    shape.passwords[instanceId] = { username, password };
    await this.write(shape);
  }

  /** Null when nothing is stored, or when the store cannot be read -- never throws. */
  async getPassword(instanceId: InstanceId): Promise<StoredPassword | null> {
    return (await this.loadAll()).shape.passwords[instanceId] ?? null;
  }

  /**
   * Behind Setup's "Forget this password". Removing what is absent is not an
   * error, and costs no write -- which also means it cannot fail on a machine
   * whose encryption has stopped working, where there is nothing to forget.
   */
  async forgetPassword(instanceId: InstanceId): Promise<void> {
    const { shape } = await this.loadAll();
    if (!shape.passwords[instanceId]) return;
    delete shape.passwords[instanceId];
    await this.write(shape);
  }

  /**
   * Store one site's model endpoint.
   *
   * VALIDATED AGAINST CORE'S OWN RULES, NOT A COPY OF THEM. `assertUsableBudget`
   * (slice.ts), `assertUsableCap` (fill.ts) and `assertUsableTimeout`
   * (provider.ts) are the code that will actually run with these numbers, and
   * they are exported precisely so this boundary can ask them. Restating the
   * rules here would give the settings screen a second opinion free to drift
   * from the first -- and the failure that produces is the worst-shaped one
   * available: a value accepted on Setup and refused four hundred rows into a
   * run, by a message about a text box the operator closed an hour ago.
   *
   * Checked BEFORE anything is read or written, so a refused setting leaves the
   * store exactly as it was rather than half-updated.
   *
   * ## A blank key keeps the stored one -- but only for the same endpoint
   *
   * Setup never renders a stored key back into its box (see `ModelChoice` in
   * ipc.ts), so the form submitted by an operator who only raised the character
   * budget carries an empty key. Reading that as a deletion would throw away a
   * credential they never touched, and they can only replace it by finding it
   * again -- the identical trap `saveInstance` avoids for a blank password.
   *
   * BUT THE KEY BELONGS TO THE ENDPOINT, not to the site. Carrying it across a
   * change of address would send a key issued by one service to a different
   * one: repoint a site from `api.openai.com` to a model on this machine and
   * the old rule would hand the operator's paid key to their own Ollama, in
   * plain http, for nothing. So the stored key is kept only when the origin has
   * not moved; anywhere else, a blank key means no key.
   */
  async setModel(instanceId: InstanceId, settings: ModelSettings): Promise<void> {
    // The SAME function `parseStoredModel` catches on, so a write that succeeds
    // is a write that reads back. Accepting a blank address here used to
    // resolve successfully and then read back as null.
    assertUsableModel(settings);
    this.requireEncryption();
    const { shape } = await this.loadAll();
    const previous = shape.models[instanceId];
    const apiKey =
      settings.apiKey !== '' ||
      previous === undefined ||
      !sameOrigin(previous.baseUrl, settings.baseUrl)
        ? settings.apiKey
        : previous.apiKey;
    shape.models[instanceId] = { ...settings, apiKey };
    await this.write(shape);
  }

  /**
   * This site's model endpoint, or null when nothing is configured.
   *
   * NULL IS WHAT MAKES THE FEATURE ABSENT. Every surface reads it that way, so
   * a site that has never been given an endpoint gets exactly today's
   * behaviour: no prompt, no error, no degraded mode, nothing sent anywhere.
   * Never throws -- an unreadable store is "no model", same as every other read
   * here.
   */
  async getModel(instanceId: InstanceId): Promise<ModelSettings | null> {
    return (await this.loadAll()).shape.models[instanceId] ?? null;
  }

  /**
   * Behind Setup's "Forget these model settings". Removes the endpoint and its
   * key while leaving the site, its credentials and its per-site settings
   * alone. Removing what is absent is not an error and costs no write, so it
   * cannot fail on a machine whose encryption has stopped working -- where
   * there is nothing to forget in the first place.
   */
  async forgetModel(instanceId: InstanceId): Promise<void> {
    const { shape } = await this.loadAll();
    if (!shape.models[instanceId]) return;
    delete shape.models[instanceId];
    await this.write(shape);
  }

  /** The instance itself -- address, name and per-site settings -- without its credentials. */
  async loadInstance(instanceId: InstanceId): Promise<Instance | null> {
    const stored = (await this.loadAll()).shape.instances[instanceId];
    return stored ? toInstance(instanceId, stored) : null;
  }

  /** Every instance the operator has added, for the dropdowns. Credentials stay here. */
  async listInstances(): Promise<Instance[]> {
    const { shape } = await this.loadAll();
    return Object.entries(shape.instances).map(([id, e]) => toInstance(id, e));
  }

  async hasSettings(instanceId: InstanceId): Promise<boolean> {
    return (await this.loadSettings(instanceId)) !== null;
  }

  /**
   * Whether readable credentials written by an older version of this store
   * were found and discarded, so Setup can say so instead of presenting a
   * blank form that looks like a broken app.
   *
   * True only when a store was successfully decrypted and parsed and turned
   * out to be a shape this version does not accept. A blob that would not
   * decrypt at all is NOT reported: the notice claims something specific
   * happened to the operator's credentials, and an unreadable file is no
   * evidence of it.
   *
   * It reports the state of the file, so it stops being true the moment the
   * operator saves anything -- the old blob is overwritten by then and there
   * is nothing left to explain. That is what makes the notice appear once.
   */
  async credentialsDropped(): Promise<boolean> {
    return (await this.loadAll()).dropped;
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /**
   * The one refusal, shared by every write: an OS with no working encryption
   * must not be quietly downgraded to a plaintext file holding somebody's
   * client secret or account password.
   */
  private requireEncryption(): void {
    if (!this.cipher.isAvailable()) {
      throw new Error(
        'OS encryption is unavailable, so credentials cannot be stored safely. ' +
          'Refusing to write them in plaintext.',
      );
    }
  }

  private async write(shape: StoredShapeV3): Promise<void> {
    this.requireEncryption();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, this.cipher.encrypt(JSON.stringify(shape)));
  }

  /** Reads and validates the on-disk store. Never throws -- see class doc. */
  private async loadAll(): Promise<LoadResult> {
    const empty = (dropped = false): LoadResult => ({
      shape: { version: 3, instances: {}, passwords: {}, models: {} },
      dropped,
    });
    let blob: Buffer;
    try {
      blob = await readFile(this.filePath);
    } catch {
      // No file: a fresh install, with nothing to explain to anybody.
      return empty();
    }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(blob)) as Partial<StoredShapeV3>;
      if (parsed.version !== 3 || typeof parsed.instances !== 'object' || parsed.instances === null) {
        // A v2 store, the old single-pair format, or anything else
        // unrecognised. Discarded, and reported as discarded. See the
        // migration note in this class's doc comment.
        return empty(true);
      }
      const instances: Record<InstanceId, StoredEntry> = {};
      for (const [id, v] of Object.entries(parsed.instances as Record<string, unknown>)) {
        const entry = parseStoredEntry(v);
        if (entry) instances[id] = entry;
      }
      // Absent on any v3 file written before password auth existed, which is
      // simply "no passwords stored" -- no migration, nothing dropped.
      const passwords: Record<InstanceId, StoredPassword> = {};
      const rawPasswords = parsed.passwords;
      if (typeof rawPasswords === 'object' && rawPasswords !== null) {
        for (const [id, v] of Object.entries(rawPasswords as Record<string, unknown>)) {
          const account = parseStoredPassword(v);
          if (account) passwords[id] = account;
        }
      }
      // Absent on any v3 file written before model settings existed, which is
      // simply "no model configured" -- no migration, nothing dropped, every
      // credential in the file untouched. See `StoredShapeV3.models`: this key
      // was added exactly the way `passwords` was, and for the same reason.
      const models: Record<InstanceId, ModelSettings> = {};
      const rawModels = parsed.models;
      if (typeof rawModels === 'object' && rawModels !== null) {
        for (const [id, v] of Object.entries(rawModels as Record<string, unknown>)) {
          const model = parseStoredModel(v);
          if (model) models[id] = model;
        }
      }
      return { shape: { version: 3, instances, passwords, models }, dropped: false };
    } catch {
      // Corrupt, hand-edited, or written by a different OS user. Treat as
      // absent: the resulting "set up your credentials" prompt is the right
      // recovery either way. Not reported as a drop -- nothing was read.
      return empty();
    }
  }
}

/**
 * `TokenStore` backed by OS encryption instead of a plaintext JSON file.
 *
 * `clearSync` exists because `AuthProvider.invalidate()` is synchronous and
 * `client.ts` retries in the same tick -- an async clear would race that
 * retry. See the note in core/tokenStore.ts.
 */
export class EncryptedTokenStore implements TokenStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  async save(data: StoredToken): Promise<void> {
    if (!this.cipher.isAvailable()) throw new Error('OS encryption unavailable; refusing to store a token.');
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, this.cipher.encrypt(JSON.stringify(data)));
  }

  async loadRaw(): Promise<StoredToken | null> {
    let blob: Buffer;
    try {
      blob = readFileSync(this.filePath);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(blob)) as Partial<StoredToken>;
      if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') return null;
      if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl === '') return null;
      return {
        accessToken: parsed.accessToken,
        baseUrl: parsed.baseUrl,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
      };
    } catch {
      // Corrupt, hand-edited, or written by a different OS user. Treat as
      // absent -- see core/tokenStore.ts for why this is the right recovery.
      return null;
    }
  }

  async load(baseUrl: string): Promise<string | null> {
    const raw = await this.loadRaw();
    if (!raw) return null;
    if (raw.baseUrl !== baseUrl) return null;
    if (raw.expiresAt !== undefined && raw.expiresAt <= Date.now()) return null;
    return raw.accessToken;
  }

  async clear(): Promise<void> {
    this.clearSync();
  }

  clearSync(): void {
    try {
      unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
