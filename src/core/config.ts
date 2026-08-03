import { OeqError } from './errors.js';
import type { AuthProvider } from './auth.js';
import { OAuthClientCredentials } from './auth.js';
import { AuthorizationCodeAuth } from './authCode.js';
import { FileTokenStore, type TokenStore } from './tokenStore.js';

/** Which OAuth grant to authenticate with. See "Authentication — revised" in the design doc. */
export type AuthMode = 'code' | 'client_credentials';

export interface Config {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  collectionUuid: string;
  schemaUuid: string;
  authMode: AuthMode;
  /** Registered redirect URI for the authorization-code flow. Always trailing-slash-free. */
  redirectUri: string;
}

const DEFAULT_COLLECTION = 'bb348ab1-7a81-4e37-8ef7-adc095ade4f9';
const DEFAULT_SCHEMA = 'c93181f3-a443-41bf-9afe-ac9f7daf90b7';

export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = ['OEQ_BASE_URL', 'OEQ_CLIENT_ID', 'OEQ_CLIENT_SECRET'] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new OeqError(
      `Missing required environment variables:\n${missing.map((m) => `  ${m}`).join('\n')}\n` +
        `Copy .env.example to .env and fill them in.`,
    );
  }

  const authModeRaw = env.OEQ_AUTH_MODE ?? 'code';
  if (authModeRaw !== 'code' && authModeRaw !== 'client_credentials') {
    throw new OeqError(
      `OEQ_AUTH_MODE must be "code" or "client_credentials", got "${authModeRaw}".`,
    );
  }

  const baseUrl = env.OEQ_BASE_URL!.replace(/\/+$/, '');
  // The registered redirectUrl on this instance is the site root, not a
  // local callback (see authCode.ts) -- so the base URL is the sane
  // default. The trailing slash is stripped either way because the server
  // strips it from whatever it receives and a mismatch fails the exchange.
  const redirectUri = (env.OEQ_REDIRECT_URI ?? baseUrl).replace(/\/+$/, '');

  return {
    baseUrl,
    clientId: env.OEQ_CLIENT_ID!,
    clientSecret: env.OEQ_CLIENT_SECRET!,
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
  if (cfg.authMode === 'client_credentials') {
    return new OAuthClientCredentials(cfg.baseUrl, cfg.clientId, cfg.clientSecret);
  }
  const store =
    tokenStore ?? (env.OEQ_TOKEN_STORE_PATH ? new FileTokenStore(env.OEQ_TOKEN_STORE_PATH) : undefined);
  return new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, store);
}
