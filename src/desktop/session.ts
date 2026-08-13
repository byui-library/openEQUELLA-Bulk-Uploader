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
 * The provider for everything that just needs to be authenticated: current
 * user, collection list, plan, run.
 *
 * Delegates to `createAuthProvider` rather than constructing one, so
 * `cfg.authMode` is honoured in exactly one place. This used to build an
 * `AuthorizationCodeAuth` unconditionally, which meant a password-mode
 * config produced an OAuth provider with an empty client id and openEQUELLA's
 * misleading "client_id (null)" error.
 */
export function buildAuth(cfg: Config, store: TokenStore): AuthProvider {
  return createAuthProvider(cfg, {}, store);
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
