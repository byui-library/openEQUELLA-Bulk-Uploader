import { OeqError } from './errors.js';

export interface Config {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  collectionUuid: string;
  schemaUuid: string;
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
  return {
    baseUrl: env.OEQ_BASE_URL!.replace(/\/+$/, ''),
    clientId: env.OEQ_CLIENT_ID!,
    clientSecret: env.OEQ_CLIENT_SECRET!,
    collectionUuid: env.OEQ_COLLECTION_UUID ?? DEFAULT_COLLECTION,
    schemaUuid: env.OEQ_SCHEMA_UUID ?? DEFAULT_SCHEMA,
  };
}
