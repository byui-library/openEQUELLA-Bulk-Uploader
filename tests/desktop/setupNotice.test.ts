import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, type Cipher } from '../../src/desktop/secrets.js';
import { setupNotice } from '../../src/desktop/ui/setupNotice.js';

/**
 * The clean break (2026-08-12) discards credentials stored by v1.0.0 and
 * sends the operator back to Setup. An empty form with no explanation reads
 * as a broken app -- worse, the client secret has been reset independently,
 * so "just type what you had" is wrong advice. This pair of tests is the
 * whole cost of that decision, and it runs the real path: the store decides
 * whether credentials were dropped, and the notice says so.
 *
 * Deliberately end-to-end from the store rather than from a bare boolean. A
 * test that only fed `setupNotice(true)` would still pass if the store
 * stopped noticing the discarded blob entirely, which is exactly the
 * regression that leaves the operator with no explanation.
 */
const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decrypt: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8'),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-setup-notice-'));
});

describe('the Setup notice', () => {
  it('explains the blank form when credentials from an older version were dropped', async () => {
    const path = join(dir, 'settings.enc');
    const store = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({
          version: 2,
          instances: { production: { clientId: 'prod-id', clientSecret: 'prod-secret' } },
        }),
      ),
    );

    const html = setupNotice(await store.credentialsDropped());
    expect(html).toContain('stores credentials differently');
    expect(html).toContain('client secret has been reset');
    expect(html).toMatch(/administrator/i);
  });

  it('says nothing on a fresh install, which has nothing to explain', async () => {
    const store = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    expect(setupNotice(await store.credentialsDropped())).toBe('');
  });

  it('says nothing once the operator has saved credentials again', async () => {
    const path = join(dir, 'settings.enc');
    const store = new SecretStore(path, fakeCipher);
    await writeFile(
      path,
      fakeCipher.encrypt(
        JSON.stringify({ version: 2, instances: { production: { clientId: 'a', clientSecret: 'b' } } }),
      ),
    );
    await store.saveInstance(
      { label: 'Live', baseUrl: 'https://oeq.example.edu' },
      { authMode: 'code', clientId: 'cid', clientSecret: 'shhh', redirectUri: 'https://oeq.example.edu' },
    );
    expect(setupNotice(await store.credentialsDropped())).toBe('');
  });
});
