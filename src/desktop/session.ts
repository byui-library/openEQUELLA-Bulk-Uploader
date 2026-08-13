import { loadConfig, createAuthProvider, type Config } from '../core/config.js';
import type { AuthProvider } from '../core/auth.js';
import { AuthorizationCodeAuth } from '../core/authCode.js';
import { OeqClient } from '../core/client.js';
import type { Instance, Settings } from './secrets.js';
import type { TokenStore } from '../core/tokenStore.js';
import { ValidationError } from '../core/errors.js';

/**
 * The guard that used to be `instanceById`: refuse an id nothing knows about
 * rather than carrying on with a guess.
 *
 * The LOOKUP moved to SecretStore -- instances are the operator's own now,
 * not a list this app ships (ipc.ts) -- but the refusal still belongs in one
 * place, and it must name the id, since an operator who has cleared their
 * settings or edited the store by hand needs to see what was actually asked
 * for.
 */
export function requireInstance(instanceId: string, instance: Instance | null): Instance {
  if (!instance) {
    throw new ValidationError(
      `Unknown instance '${instanceId}'. Add its address in Setup, or pick one that is already saved.`,
    );
  }
  return instance;
}

/**
 * Synthesises an env-shaped object and hands it to the core's own
 * `loadConfig`, so validation rules live in exactly one place.
 *
 * THE MODE COMES FROM THE STORED SETTINGS. It used to be the literal
 * `'code'`, which meant the desktop could never produce anything else: Setup
 * could collect a username and password, `buildAuth` could honour every mode
 * correctly, and an institution not behind SSO would still be handed an OAuth
 * provider with an empty client id and openEQUELLA's misleading "client_id
 * (null)". `loadConfig`'s required-variable list is already mode-dependent,
 * so password mode is not asked for an OAuth client it does not have.
 *
 * The two branches send DISJOINT variables rather than one object with the
 * unused half blanked out: an empty `OEQ_CLIENT_ID` is indistinguishable to
 * `loadConfig` from a missing one, and an empty `OEQ_USERNAME` would defeat
 * the very check that tells a password-mode operator they have not signed in.
 *
 * OEQ_REDIRECT_URI comes from `settings.redirectUri` -- the per-instance
 * STORED value (secrets.ts), collected in Setup -- and is passed through
 * verbatim, never derived from `instance.baseUrl` here. It is registered on
 * the OAuth client by an administrator and is not derivable: one client's
 * registered value has a trailing slash, another's does not. That value has
 * been hard-coded wrong here twice already; it must never be derived again.
 * It is sent in OAuth mode only; password auth has no redirect at all, and
 * `loadConfig` defaults the field for it.
 *
 * OEQ_ATTACHMENT_UUID_PATH comes from `instance.attachmentUuidPath` -- the
 * per-instance STORED setting (secrets.ts), collected on Setup. It USED TO be
 * read from `process.env`, which works for a developer running `npm run
 * desktop` and is useless for the operator, who launches the packaged app from
 * a Start Menu shortcut with no environment set. The effect was silent: a
 * BYU-Idaho operator using the GUI created items with no
 * `BYUI_extended/attachments/attachment` at all -- no error, no warning, just
 * absent from every contribution, and nothing to notice until somebody went
 * looking in openEQUELLA weeks later. There is no env fallback left on
 * purpose: a fallback that only works on the developer's machine is how this
 * hid for as long as it did.
 *
 * Blank -- the default, and correct for a schema that declares no such node --
 * means the attachment uuid is written into no metadata field at all. It is
 * passed through blank, never coerced into a guess.
 */
export function buildConfig(instance: Instance, settings: Settings, collectionUuid: string): Config {
  const credentials =
    settings.authMode === 'password'
      ? {
          OEQ_AUTH_MODE: 'password',
          OEQ_USERNAME: settings.username,
          OEQ_PASSWORD: settings.password,
        }
      : {
          OEQ_AUTH_MODE: 'code',
          OEQ_CLIENT_ID: settings.clientId,
          OEQ_CLIENT_SECRET: settings.clientSecret,
          OEQ_REDIRECT_URI: settings.redirectUri,
        };

  return loadConfig({
    OEQ_BASE_URL: instance.baseUrl,
    OEQ_COLLECTION_UUID: collectionUuid,
    OEQ_ATTACHMENT_UUID_PATH: instance.attachmentUuidPath,
    ...credentials,
  });
}

/**
 * A provider holding an openEQUELLA session that can be ended on the server.
 *
 * Structural, not `UsernamePasswordAuth`, because it is a capability rather
 * than a class: `AuthProvider` (core/auth.ts) does not declare `logout()`, and
 * only password auth has one. `AuthorizationCodeAuth` holds a bearer token,
 * not a server session, and clearing the token store is a complete logout for
 * it -- which the signOut handler already does.
 */
interface EndableSession {
  logout(): Promise<void>;
}

/**
 * Every provider built for an instance during this app run, so its session can
 * actually be ended.
 *
 * WHY THIS HAS TO EXIST. `UsernamePasswordAuth.logout()` can only end the
 * session held by the provider it is called on, and a provider that never
 * signed in makes no request at all (see its doc comment, and
 * tests/passwordAuth.test.ts). Every IPC handler builds its own provider and
 * drops it on return, so before this registry the desktop had nothing left to
 * log out: constructing a provider from the stored credential in order to end
 * a session would have SIGNED IN first and then ended that brand-new session,
 * leaving the real one alive. The CLI reached the same conclusion and declined
 * (`LogoutDeps.auth` in cli/index.ts). Holding the providers is what makes
 * ending a session possible without creating one.
 *
 * A SITE CAN HOLD SEVERAL AT ONCE, which is why the value is a Set rather than
 * one provider: each handler call signs in again, so a site accumulates one
 * server session per call. Ending "the" session would leave the rest live.
 * Reusing one provider per instance instead would fix that too, but it would
 * also make one long-lived session serve every later request -- and a session
 * openEQUELLA has since expired is answered as the guest with 200 and empty
 * data, never a 401 (see CLAUDE.md). That is a separate decision from being
 * able to log out, and is deliberately not taken here.
 *
 * Keyed by INSTANCE ID, passed in explicitly rather than derived from
 * `cfg.baseUrl`: the two are the same string today (an id is `instanceKey` of
 * the address), and quietly depending on that would make a mismatch look like
 * "there was no session".
 */
const liveSessions = new Map<string, Set<EndableSession>>();

function canEndSession(provider: unknown): provider is EndableSession {
  return typeof (provider as EndableSession | null | undefined)?.logout === 'function';
}

/**
 * Note that a provider now exists for `instanceId`, so its session can be
 * ended later. Providers with no `logout()` are ignored rather than stored:
 * counting one would have the quit hook report sessions it did not end.
 *
 * Exported so a test can seed a live session without a network round trip;
 * production code reaches it through `buildAuth` below.
 */
export function rememberSession(instanceId: string, provider: unknown): void {
  if (!canEndSession(provider)) return;
  const existing = liveSessions.get(instanceId);
  if (existing) existing.add(provider);
  else liveSessions.set(instanceId, new Set([provider]));
}

/**
 * End every session held for one instance, and report how many there were.
 *
 * THE REGISTRY ENTRY IS DROPPED FIRST, and unconditionally -- the same rule
 * `logout()` itself follows locally. Whatever happens on the wire, this
 * process is no longer holding those sessions, and a retry would only re-send
 * a PUT for a session it can no longer prove anything about.
 *
 * A failure is REPORTED, not swallowed. Both callers have to carry on
 * regardless (the credential is forgotten either way; the app quits either
 * way), but that is their decision to take visibly rather than one hidden
 * here.
 */
export async function endSessionsFor(instanceId: string): Promise<number> {
  const sessions = liveSessions.get(instanceId);
  if (!sessions) return 0;
  liveSessions.delete(instanceId);
  await Promise.all([...sessions].map((s) => s.logout()));
  return sessions.size;
}

/** Every instance's sessions, for the quit hook. Same rules as above. */
export async function endAllSessions(): Promise<number> {
  const counts = await Promise.all([...liveSessions.keys()].map((id) => endSessionsFor(id)));
  return counts.reduce((total, n) => total + n, 0);
}

/** Drop every remembered session WITHOUT ending it. Exists for tests, which
 *  share one module instance across cases; nothing in the app should forget a
 *  session it has not ended. */
export function forgetLiveSessions(): void {
  liveSessions.clear();
}

/**
 * The provider for everything that just needs to be authenticated: current
 * user, collection list, plan, run.
 *
 * Delegates to `createAuthProvider` rather than constructing one, so
 * `cfg.authMode` is honoured in exactly one place. This used to build an
 * `AuthorizationCodeAuth` unconditionally, which meant a password-mode
 * config produced an OAuth provider with an empty client id and openEQUELLA's
 * misleading "client_id (null)" error.
 *
 * `instanceId` is REQUIRED, and is not optional-with-a-fallback on purpose:
 * this is the one choke point every desktop provider passes through, and a
 * call site that omitted the id would silently leave its session unendable --
 * exactly the half-logout this registry exists to remove, and invisible until
 * somebody checked the server.
 */
export function buildAuth(cfg: Config, store: TokenStore, instanceId: string): AuthProvider {
  const provider = createAuthProvider(cfg, {}, store);
  rememberSession(instanceId, provider);
  return provider;
}

/**
 * The interactive browser sign-in specifically, which is the authorization-code
 * flow and nothing else: `signInInteractive` drives `getAuthorizeUrl()` and
 * `exchangeCode()`, neither of which exists on `AuthProvider`. Kept separate
 * from `buildAuth` above so the general path can vary by mode while this one
 * stays honestly typed as the one flow it can actually drive.
 */
export function buildCodeAuth(cfg: Config, store: TokenStore): AuthorizationCodeAuth {
  return new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, store);
}

export function buildClient(cfg: Config, auth: AuthProvider): OeqClient {
  return new OeqClient(cfg.baseUrl, auth);
}
