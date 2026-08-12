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
 * OEQ_REDIRECT_URI comes from `settings.redirectUri` -- the per-instance
 * STORED value (secrets.ts), collected in Setup -- and is passed through
 * verbatim, never derived from `instance.baseUrl` here. It is registered on
 * the OAuth client by an administrator and is not derivable: one client's
 * registered value has a trailing slash, another's does not. That value has
 * been hard-coded wrong here twice already; it must never be derived again.
 *
 * OEQ_ATTACHMENT_UUID_PATH is read from the process environment because the
 * desktop has no setting for it yet (core/types.ts says what the field is).
 * Unset -- which it is for anyone who has not deliberately set it for their
 * Windows account -- means the attachment uuid is written into no metadata
 * field at all, which is correct for a schema that declares no such node. An
 * institution whose schema DOES declare one sets the variable; a per-instance
 * setting on Setup is the better home for it once the instance list itself is
 * operator-managed.
 */
export function buildConfig(
  instance: Instance,
  settings: Settings,
  collectionUuid: string,
  env: Record<string, string | undefined> = process.env,
): Config {
  return loadConfig({
    OEQ_BASE_URL: instance.baseUrl,
    OEQ_CLIENT_ID: settings.clientId,
    OEQ_CLIENT_SECRET: settings.clientSecret,
    OEQ_COLLECTION_UUID: collectionUuid,
    OEQ_REDIRECT_URI: settings.redirectUri,
    OEQ_AUTH_MODE: 'code',
    OEQ_ATTACHMENT_UUID_PATH: env.OEQ_ATTACHMENT_UUID_PATH,
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
