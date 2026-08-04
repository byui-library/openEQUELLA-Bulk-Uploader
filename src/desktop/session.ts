import { loadConfig, type Config } from '../core/config.js';
import { AuthorizationCodeAuth } from '../core/authCode.js';
import { OeqClient } from '../core/client.js';
import { INSTANCES } from './ipc.js';
import type { Settings } from './secrets.js';
import type { TokenStore } from '../core/tokenStore.js';
import { ValidationError } from '../core/errors.js';

export function instanceById(id: string) {
  const found = INSTANCES.find((i) => i.id === id);
  if (!found) throw new ValidationError(`Unknown instance '${id}'.`);
  return found;
}

/**
 * Synthesises an env-shaped object and hands it to the core's own
 * `loadConfig`, so validation rules live in exactly one place. Note
 * OEQ_REDIRECT_URI is set explicitly per instance -- it is never derived from
 * the base url, because production registers it without a trailing slash and
 * test registers it with one.
 */
export function buildConfig(instanceId: string, settings: Settings, collectionUuid: string): Config {
  const inst = instanceById(instanceId);
  return loadConfig({
    OEQ_BASE_URL: inst.baseUrl,
    OEQ_CLIENT_ID: settings.clientId,
    OEQ_CLIENT_SECRET: settings.clientSecret,
    OEQ_COLLECTION_UUID: collectionUuid,
    OEQ_REDIRECT_URI: inst.redirectUri,
    OEQ_AUTH_MODE: 'code',
  });
}

export function buildAuth(cfg: Config, store: TokenStore): AuthorizationCodeAuth {
  return new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, store);
}

export function buildClient(cfg: Config, auth: AuthorizationCodeAuth): OeqClient {
  return new OeqClient(cfg.baseUrl, auth);
}
