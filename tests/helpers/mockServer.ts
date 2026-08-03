/**
 * UNVERIFIED CONTRACT.
 *
 * This mock server is our best guess at the openEQUELLA REST wire format,
 * assembled from documentation and inference — NOT from a captured
 * `schema/swagger.json`. We have not been able to confirm it against the
 * live instance because fetching `/api/swagger.json` requires a
 * `VIEW_APIDOCS` privilege we couldn't verify we have (see CLAUDE.md,
 * "Working notes").
 *
 * Treat every route and payload shape below as a hypothesis, not a fact.
 * When `schema/swagger.json` is finally captured (or the real API responds
 * differently in practice), this file and `src/core/client.ts` are the only
 * two files that should need to change to reconcile the difference —
 * nothing downstream should depend on wire-format details directly.
 *
 * Endpoints modeled here:
 *   POST   /oauth/access_token          — client-credentials token exchange
 *   POST   /api/staging                 — create a staging area
 *   PUT    /api/staging/:uuid/:filename — upload a file into staging
 *   DELETE /api/staging/:uuid           — discard a staging area
 *   POST   /api/item                    — create an item from staged files + metadata
 *   GET    /api/search                  — pre-flight duplicate-identifier check
 *
 * Uses a real `node:http` server (not an interception library) so the
 * actual `fetch` code path — DNS/TCP/headers/streaming — is exercised.
 *
 * `state.expireNextUpload` is TEST SCAFFOLDING, not part of the modelled
 * protocol: `expireNext` (above) fires 401 on the next authorised call of
 * *any* kind, which in practice is almost always consumed by the
 * lightweight `POST /api/staging` a caller issues just before its `PUT`
 * upload — so it can never actually land on the upload request itself, the
 * one whose body is a one-shot stream. `expireNextUpload` is a narrow,
 * additive targeting knob that rejects only the next `PUT
 * /api/staging/:uuid/:filename`, so tests can prove a caller reopens a
 * fresh file body on retry rather than resending a drained one. It adds no
 * new route, status code, or payload shape — it only changes *when* the
 * existing 401 response (also used by `expireNext`) is returned.
 *
 * `state.mismatchAttachmentNext` is likewise additive test scaffolding: it
 * makes the next N `POST /api/item` calls ignore a client-supplied
 * attachment `uuid` and assign a server-generated one instead, so tests can
 * prove the runner (Task 10) detects that mismatch rather than reporting a
 * false success. It changes no route, status code, or payload shape — the
 * response still has exactly the same `{ uuid, version, attachments: [{uuid}] }`
 * shape as the default path, just with a different `uuid` value inside it.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockState {
  /** Tokens handed out, newest last. */
  issuedTokens: string[];
  /** Reject the next N authorised calls with 401, to exercise refresh. */
  expireNext: number;
  /**
   * Reject the next N `PUT` staging uploads specifically with 401. Test
   * scaffolding, not modelled protocol — see the header comment above.
   */
  expireNextUpload: number;
  /** Fail the next N item creations with 503, to exercise retry. */
  failItemNext: number;
  /**
   * Make the next N item creations ignore the client-supplied attachment
   * uuid and assign a fresh server-generated one instead. Test scaffolding
   * for the "server ignored our uuid" case — see header comment above.
   */
  mismatchAttachmentNext: number;
  stagingAreas: Set<string>;
  uploads: { staging: string; filename: string; bytes: number }[];
  items: { uuid: string; version: number; metadata: string; draft: boolean }[];
  /** Identifiers that already exist, for the duplicate pre-flight. */
  existingIdentifiers: string[];
}

export interface MockServer {
  url: string;
  state: MockState;
  close: () => Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

export async function startMockServer(): Promise<MockServer> {
  const state: MockState = {
    issuedTokens: [],
    expireNext: 0,
    expireNextUpload: 0,
    failItemNext: 0,
    mismatchAttachmentNext: 0,
    stagingAreas: new Set(),
    uploads: [],
    items: [],
    existingIdentifiers: [],
  };

  let counter = 0;
  const nextId = (p: string) => `${p}-${++counter}`;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/oauth/access_token') {
        if (url.searchParams.get('client_id') !== 'good-id') {
          return send(res, 401, { error: 'invalid_client' });
        }
        const token = nextId('token');
        state.issuedTokens.push(token);
        return send(res, 200, { access_token: token, token_type: 'bearer', expires_in: 3600 });
      }

      // Everything below requires a currently-valid token.
      const auth = req.headers['x-authorization'];
      const token = typeof auth === 'string' ? auth.replace('access_token=', '') : '';
      const current = state.issuedTokens[state.issuedTokens.length - 1];
      if (token !== current) return send(res, 401, { error: 'unauthorized' });
      if (state.expireNext > 0) {
        state.expireNext--;
        return send(res, 401, { error: 'token expired' });
      }

      if (path === '/api/staging' && req.method === 'POST') {
        const uuid = nextId('staging');
        state.stagingAreas.add(uuid);
        return send(res, 201, { uuid });
      }

      const stagingUpload = /^\/api\/staging\/([^/]+)\/(.+)$/.exec(path);
      if (stagingUpload && req.method === 'PUT') {
        if (state.expireNextUpload > 0) {
          state.expireNextUpload--;
          return send(res, 401, { error: 'token expired' });
        }
        const [, staging, filename] = stagingUpload;
        if (!state.stagingAreas.has(staging!)) return send(res, 404, { error: 'no staging area' });
        const body = await readBody(req);
        state.uploads.push({
          staging: staging!,
          filename: decodeURIComponent(filename!),
          bytes: body.length,
        });
        return send(res, 200, {});
      }

      const stagingDelete = /^\/api\/staging\/([^/]+)$/.exec(path);
      if (stagingDelete && req.method === 'DELETE') {
        state.stagingAreas.delete(stagingDelete[1]!);
        return send(res, 204, '');
      }

      if (path === '/api/item' && req.method === 'POST') {
        if (state.failItemNext > 0) {
          state.failItemNext--;
          return send(res, 503, { error: 'temporarily unavailable' });
        }
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          metadata: string;
          attachments?: { uuid?: string }[];
        };
        const uuid = nextId('item');
        state.items.push({
          uuid,
          version: 1,
          metadata: body.metadata,
          draft: url.searchParams.get('draft') === 'true',
        });
        const mismatch = state.mismatchAttachmentNext > 0;
        if (mismatch) state.mismatchAttachmentNext--;
        return send(res, 201, {
          uuid,
          version: 1,
          attachments: (body.attachments ?? []).map((a) => ({
            uuid: mismatch ? nextId('att-server-assigned') : a.uuid ?? nextId('att'),
          })),
        });
      }

      if (path === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const hit = state.existingIdentifiers.some((id) => q.includes(id));
        return send(res, 200, { available: hit ? 1 : 0, results: hit ? [{ uuid: 'existing' }] : [] });
      }

      return send(res, 404, { error: 'not found' });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
