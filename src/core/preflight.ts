import type { AuthProvider } from './auth.js';
import type { OeqClient } from './client.js';
import { ApiError } from './errors.js';
import type { Config } from './config.js';
import { DEFAULT_LOGIN_HINT } from './authCode.js';

export interface PreflightCheck {
  label: string;
  pass: boolean;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The read-only pre-flight both `oeq-upload check` (cli/index.ts) and
 * `oeq_check` (mcp/index.ts) run before any upload is attempted. Shared here
 * so the two front ends can't drift into checking different things or
 * reporting them differently -- they're meant to be exactly the same four
 * checks, just rendered two ways.
 *
 * Creates nothing. In order:
 *   1. A usable token exists (and if not, stops here -- nothing below can
 *      succeed without one, and every failure past this point would just be
 *      a confusing echo of the same root cause).
 *   2. `GET /api/content/currentuser` -- who created items will be owned by.
 *      This is the entire point of the authorization-code flow: confirming
 *      it *before* a 5.5GB batch runs, not after.
 *   3. `GET /api/collection/{uuid}` -- does the target collection exist on
 *      THIS host. The collection UUID in `Config` is identical between test
 *      and production, so `baseUrl` is the only thing telling them apart --
 *      this check is what catches OEQ_BASE_URL pointed at the wrong one.
 *   4. `GET /api/collection?privilege=CREATE_ITEM` -- can this user actually
 *      contribute to that collection; if not, which ones can they.
 *
 * `loginHint` names how the CALLING front end wants an operator told to log
 * in, since `getToken()` (authCode.ts) has no notion of which one is
 * asking and can only ever say "Run:  oeq-upload login" -- correct for the
 * CLI, meaningless for an MCP caller with no shell. Defaults to that same
 * CLI instruction (`DEFAULT_LOGIN_HINT`) so cli/index.ts's `checkAction`
 * doesn't need to pass anything; mcp/index.ts's `checkTool` passes its own.
 * Deliberately just a substring find-and-replace against the known default
 * text, not a parallel error-construction path -- the "why" (no token /
 * wrong instance / expired) still comes from `getToken()` itself, this only
 * swaps the actionable tail.
 */
export async function runPreflight(
  cfg: Config,
  auth: AuthProvider,
  client: OeqClient,
  loginHint: string = DEFAULT_LOGIN_HINT,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  try {
    await auth.getToken();
    checks.push({ label: 'Token', pass: true, message: 'present and usable.' });
  } catch (err) {
    const message = errorMessage(err).split(DEFAULT_LOGIN_HINT).join(loginHint);
    checks.push({ label: 'Token', pass: false, message });
    // Nothing below can succeed without a token, and every failure past this
    // point would just be a confusing echo of the same root cause.
    return { ok: false, checks };
  }

  try {
    const user = await client.currentUser();
    checks.push({
      label: 'Identity',
      pass: true,
      message: `logged in as ${user.username} (${user.firstName} ${user.lastName}). Created items will be owned by this user.`,
    });
  } catch (err) {
    checks.push({ label: 'Identity', pass: false, message: errorMessage(err) });
  }

  try {
    const collection = await client.getCollection(cfg.collectionUuid);
    checks.push({
      label: 'Collection',
      pass: true,
      message: `'${collection.name}' (${collection.uuid}) exists on ${cfg.baseUrl}.`,
    });
  } catch (err) {
    const notFound = err instanceof ApiError && err.status === 404;
    checks.push({
      label: 'Collection',
      pass: false,
      message: notFound
        ? `${cfg.collectionUuid} does not exist on ${cfg.baseUrl}. Check OEQ_BASE_URL and ` +
          `OEQ_COLLECTION_UUID -- the same collection UUID exists in both test and production, ` +
          `so it's easy to point this at the wrong host without noticing.`
        : errorMessage(err),
    });
  }

  try {
    const creatable = await client.listCollections({ privilege: 'CREATE_ITEM', length: 100 });
    const target = creatable.find((c) => c.uuid === cfg.collectionUuid);
    if (target) {
      checks.push({
        label: 'Permission',
        pass: true,
        message: `CREATE_ITEM confirmed on '${target.name}'.`,
      });
    } else if (creatable.length > 0) {
      checks.push({
        label: 'Permission',
        pass: false,
        message:
          `CREATE_ITEM not confirmed on ${cfg.collectionUuid}. Collections you CAN contribute to:\n` +
          creatable.map((c) => `    - ${c.name} (${c.uuid})`).join('\n'),
      });
    } else {
      checks.push({
        label: 'Permission',
        pass: false,
        message: 'CREATE_ITEM not confirmed on any collection for this user.',
      });
    }
  } catch (err) {
    checks.push({ label: 'Permission', pass: false, message: errorMessage(err) });
  }

  return { ok: checks.every((c) => c.pass), checks };
}
