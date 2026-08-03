import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/core/config.js';

describe('loadConfig', () => {
  it('reads values from the environment', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
      OEQ_SCHEMA_UUID: 's1',
    });
    expect(cfg.baseUrl).toBe('https://example.test');
    expect(cfg.collectionUuid).toBe('c1');
  });

  it('names every missing variable at once, not one at a time', () => {
    expect(() => loadConfig({})).toThrow(/OEQ_BASE_URL.*OEQ_CLIENT_ID.*OEQ_CLIENT_SECRET/s);
  });

  it('strips a trailing slash from the base url', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test/',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
    });
    expect(cfg.baseUrl).toBe('https://example.test');
  });
});
