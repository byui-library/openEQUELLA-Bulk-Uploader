/**
 * PARTIALLY VERIFIED CONTRACT.
 *
 * This mock server models the openEQUELLA REST wire format used by
 * `src/core/client.ts`. `schema/swagger.json` (Swagger 2.0, basePath `/api`)
 * has since arrived from the live instance and confirmed several details
 * that were previously guesses — see the CONFIRMED/UNVERIFIED breakdown in
 * `client.ts`'s header comment, which this file mirrors:
 *
 *   - CONFIRMED: `POST /api/item` takes the staging area id as a `file`
 *     QUERY PARAM (not a body field), alongside `draft`. This mock 404s if
 *     `file` is missing or names a staging area that doesn't exist, so a
 *     regression back to sending it in the body fails loudly instead of
 *     silently creating an orphaned attachment.
 *   - CONFIRMED: `GET /api/search`'s `showall` query param (default false)
 *     gates whether non-live (e.g. draft) items are matched. This mock only
 *     reports a hit when `showall=true`, so a regression that stops sending
 *     it fails loudly instead of silently missing every draft duplicate.
 *   - CONFIRMED: `POST /api/item`'s response shape is unspecified by the
 *     spec. This mock's default path returns a JSON body; `locationStyleNext`
 *     (additive test scaffolding, see MockState) makes it instead return a
 *     201 with an empty body and a `Location: /item/{uuid}/{version}`
 *     header, proving the client tolerates both.
 *   - STILL UNVERIFIED: everything else below (the `/oauth/access_token`
 *     shape, all of `/api/staging/*`, and the attachment payload's exact
 *     field set) remains a hypothesis, not a fact — swagger.json does not
 *     cover `/oauth/access_token` (outside its basePath) and has no
 *     `/staging` path at all (its only file-related paths are under
 *     `/file/{uuid}/...`, a materially different shape). Treat those routes
 *     here as before: a guess, pending a dedicated verification pass.
 *
 * When the next discrepancy turns up, this file and `src/core/client.ts`
 * are the only two files that should need to change to reconcile it —
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
 *
 * `state.locationStyleNext` is additive test scaffolding modelling the
 * *other* response shape swagger.json's lack of a `POST /api/item` schema
 * permits: instead of the default `{ uuid, version, attachments }` JSON
 * body, it makes the next N item creations return a 201 with an EMPTY body
 * and a `Location: /item/{uuid}/{version}` header, so tests can prove the
 * client recovers a uuid/version from either shape rather than
 * misreporting a genuinely-created item as a parse failure.
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
  /**
   * Make the next N item creations respond 201 with an empty body and a
   * `Location: /item/{uuid}/{version}` header instead of a JSON body. Test
   * scaffolding for the "unspecified response shape" case — see header
   * comment above.
   */
  locationStyleNext: number;
  stagingAreas: Set<string>;
  uploads: { staging: string; filename: string; bytes: number }[];
  items: {
    uuid: string;
    version: number;
    metadata: string;
    draft: boolean;
    /** The `file` query param the item was created with -- CONFIRMED to be
     * a query param, not a body field, against swagger.json. */
    stagingFile: string;
  }[];
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
    locationStyleNext: 0,
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
        // CONFIRMED against swagger.json: the staging area is the `file`
        // query param, not a body field (`ItemBean` has no such property).
        // 404 if it's missing or names a staging area that was never
        // created, so a regression back to sending it in the body -- where
        // it would be silently ignored -- fails loudly here instead.
        const fileParam = url.searchParams.get('file');
        if (!fileParam || !state.stagingAreas.has(fileParam)) {
          return send(res, 404, { error: 'no such staging area' });
        }
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          metadata: string;
          attachments?: { uuid?: string }[];
        };
        const uuid = nextId('item');
        const version = 1;
        state.items.push({
          uuid,
          version,
          metadata: body.metadata,
          draft: url.searchParams.get('draft') === 'true',
          stagingFile: fileParam,
        });
        const mismatch = state.mismatchAttachmentNext > 0;
        if (mismatch) state.mismatchAttachmentNext--;

        if (state.locationStyleNext > 0) {
          state.locationStyleNext--;
          // CONFIRMED against swagger.json: POST /item's response has no
          // documented schema. Model openEQUELLA's common alternative here
          // -- 201, empty body, uuid/version only recoverable from Location.
          res.writeHead(201, { location: `/item/${uuid}/${version}` });
          return res.end();
        }
        return send(res, 201, {
          uuid,
          version,
          attachments: (body.attachments ?? []).map((a) => ({
            uuid: mismatch ? nextId('att-server-assigned') : a.uuid ?? nextId('att'),
          })),
        });
      }

      if (path === '/api/search' && req.method === 'GET') {
        // CONFIRMED against swagger.json: `showall` (default false) gates
        // whether non-live items are matched at all. Items here default to
        // draft, i.e. not live, so a hit requires showall=true regardless
        // of whether the identifier is otherwise known -- modelling the
        // live server's default of excluding drafts entirely.
        const showAll = url.searchParams.get('showall') === 'true';
        const q = url.searchParams.get('q') ?? '';
        const hit = showAll && state.existingIdentifiers.some((id) => q.includes(id));
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
