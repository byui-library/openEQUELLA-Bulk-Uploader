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
  /**
   * Metadata xpath that should receive each item's attachment uuid, in
   * spreadsheet-header form (`Local/attachments/attachment`).
   *
   * EMPTY BY DEFAULT, and empty means "write nothing". This is a convenience
   * index some schemas declare beside the attachment itself; the attachment is
   * linked through the attachment API and does not depend on it. Writing a
   * guessed path would write to a node the collection's schema does not have,
   * on every item created -- see runner.ts, which also stops treating a
   * server-assigned attachment uuid as a defect when nothing referenced the
   * one it asked for.
   */
  attachmentUuidPath: string;
}

/*
 * There are deliberately NO default collection or schema uuids here.
 *
 * `OEQ_COLLECTION_UUID` used to fall back to BYU-Idaho's own collection, so an
 * institution that had not set it got a real, valid-looking uuid they never
 * chose; the only symptom was a not-found from the server naming an identifier
 * they could not recognise. `OEQ_COLLECTION_UUID` is a required variable now,
 * in every auth mode -- the "Missing required environment variables" error
 * names it, which is the outcome a default was hiding.
 *
 * `OEQ_SCHEMA_UUID` is recorded in the manifest and sent nowhere (see
 * CLAUDE.md), so it stays optional and defaults to empty rather than becoming
 * a required variable for a value nothing reads.
 */

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
  // OEQ_COLLECTION_UUID is in BOTH branches: the mode decides how you sign in,
  // not whether you need somewhere to contribute to.
  const required =
    authModeRaw === 'password'
      ? (['OEQ_BASE_URL', 'OEQ_COLLECTION_UUID', 'OEQ_USERNAME', 'OEQ_PASSWORD'] as const)
      : (['OEQ_BASE_URL', 'OEQ_COLLECTION_UUID', 'OEQ_CLIENT_ID', 'OEQ_CLIENT_SECRET'] as const);
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
    collectionUuid: env.OEQ_COLLECTION_UUID!,
    schemaUuid: env.OEQ_SCHEMA_UUID ?? '',
    // Normalised to spreadsheet-header form: openEQUELLA writes its own paths
    // with a leading slash (`/MWDL/title`), so one pasted from a schema browser
    // arrives as `/Local/attachments/attachment` while every header and every
    // metadata xpath in this tool is slashless. The field is write-only, so a
    // mismatch would never be noticed -- it would just land somewhere else.
    attachmentUuidPath: (env.OEQ_ATTACHMENT_UUID_PATH ?? '').trim().replace(/^\/+/, ''),
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
