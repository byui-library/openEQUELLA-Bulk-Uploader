import { OeqError } from './errors.js';
import type { AuthProvider } from './auth.js';
import { OAuthClientCredentials } from './auth.js';
import { AuthorizationCodeAuth } from './authCode.js';
import { FileTokenStore, type TokenStore } from './tokenStore.js';
import { UsernamePasswordAuth } from './passwordAuth.js';

/** Which sign-in method to use. See the institution-agnostic design doc. */
export type AuthMode = 'code' | 'client_credentials' | 'password';

export interface Config {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  collectionUuid: string;
  schemaUuid: string;
  authMode: AuthMode;
  /**
   * Registered redirect URI for the authorization-code flow, used VERBATIM
   * (see authCode.ts) -- it must match the OAuth client's registered
   * `redirectUrl` character-for-character, including any trailing slash.
   * Defaults to `baseUrl + '/'` (see loadConfig() below) since that's what
   * this instance's client is registered with; an admin registering a
   * dedicated client with a different `redirectUrl` (e.g. a loopback
   * callback) must set `OEQ_REDIRECT_URI` to match it exactly.
   */
  redirectUri: string;
  /** Set only in `password` mode. */
  username: string;
  /** Set only in `password` mode. Never logged, never written to the manifest. */
  password: string;
}

const DEFAULT_COLLECTION = 'bb348ab1-7a81-4e37-8ef7-adc095ade4f9';
const DEFAULT_SCHEMA = 'c93181f3-a443-41bf-9afe-ac9f7daf90b7';

export function loadConfig(env: Record<string, string | undefined>): Config {
  const authModeRaw = env.OEQ_AUTH_MODE ?? 'code';
  if (authModeRaw !== 'code' && authModeRaw !== 'client_credentials' && authModeRaw !== 'password') {
    throw new OeqError(
      `OEQ_AUTH_MODE must be "code", "client_credentials" or "password", got "${authModeRaw}".`,
    );
  }

  // Which variables are required depends on the mode: an institution using
  // password auth has no OAuth client at all, so demanding a client id would
  // make the mode unusable.
  const required =
    authModeRaw === 'password'
      ? (['OEQ_BASE_URL', 'OEQ_USERNAME', 'OEQ_PASSWORD'] as const)
      : (['OEQ_BASE_URL', 'OEQ_CLIENT_ID', 'OEQ_CLIENT_SECRET'] as const);
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new OeqError(
      `Missing required environment variables:\n${missing.map((m) => `  ${m}`).join('\n')}\n` +
        `Copy .env.example to .env and fill them in.`,
    );
  }

  const baseUrl = env.OEQ_BASE_URL!.replace(/\/+$/, '');
  // The registered redirectUrl on this instance is the site root WITH a
  // trailing slash -- confirmed live: `content-test.byui.edu` (no slash)
  // fails with "No OAuth client can be found ...", `content-test.byui.edu/`
  // (with one) works. So the default must add the slash back after
  // `baseUrl` strips it above. This value is sent VERBATIM by authCode.ts --
  // no further normalisation happens there, and none should happen here for
  // an explicit OEQ_REDIRECT_URI either: whatever the operator sets must
  // match their OAuth client's registered redirectUrl exactly, trailing
  // slash and all, so silently editing it would just move the mismatch
  // somewhere harder to see.
  const redirectUri = env.OEQ_REDIRECT_URI ?? `${baseUrl}/`;

  return {
    baseUrl,
    clientId: env.OEQ_CLIENT_ID ?? '',
    clientSecret: env.OEQ_CLIENT_SECRET ?? '',
    username: env.OEQ_USERNAME ?? '',
    password: env.OEQ_PASSWORD ?? '',
    collectionUuid: env.OEQ_COLLECTION_UUID ?? DEFAULT_COLLECTION,
    schemaUuid: env.OEQ_SCHEMA_UUID ?? DEFAULT_SCHEMA,
    authMode: authModeRaw,
    redirectUri,
  };
}

/**
 * Builds the right `AuthProvider` for `cfg.authMode` so callers (CLI, MCP
 * server) don't have to branch on it themselves.
 *
 * `env` is accepted alongside `cfg` (which already carries the resolved
 * `authMode`) for symmetry with `loadConfig` and so a caller can point the
 * default token store elsewhere via `OEQ_TOKEN_STORE_PATH` without having to
 * construct a `TokenStore` by hand; it's optional and only consulted for the
 * `'code'` mode. `tokenStore`, if supplied, wins over both and is how tests
 * avoid touching the real filesystem path.
 */
export function createAuthProvider(
  cfg: Config,
  env: Record<string, string | undefined> = {},
  tokenStore?: TokenStore,
): AuthProvider {
  if (cfg.authMode === 'password') {
    return new UsernamePasswordAuth(cfg.baseUrl, cfg.username, cfg.password);
  }
  if (cfg.authMode === 'client_credentials') {
    return new OAuthClientCredentials(cfg.baseUrl, cfg.clientId, cfg.clientSecret);
  }
  const store =
    tokenStore ?? (env.OEQ_TOKEN_STORE_PATH ? new FileTokenStore(env.OEQ_TOKEN_STORE_PATH) : undefined);
  return new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, store);
}
