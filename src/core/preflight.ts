import type { AuthProvider } from './auth.js';
import type { OeqClient } from './client.js';
import { ApiError } from './errors.js';
import type { Config } from './config.js';
import type { SchemaInfo } from './discovery.js';
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

  // Captured for the attachment-field check below: choosing a collection also
  // determines its schema, so nothing has to be configured twice.
  let schemaUuid = '';
  try {
    const collection = await client.getCollection(cfg.collectionUuid);
    schemaUuid = collection.schemaUuid ?? '';
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

  checks.push(await attachmentFieldCheck(cfg, client, schemaUuid));

  return { ok: checks.every((c) => c.pass), checks };
}

/**
 * Whether `OEQ_ATTACHMENT_UUID_PATH` names a node the target collection's
 * schema actually has.
 *
 * This field is written on EVERY item the runner creates (see runner.ts), so a
 * wrong path is a mistake repeated across the whole batch, and openEQUELLA's
 * response to metadata at an undeclared path is not something the resulting
 * error message would explain. Checking it costs one read-only request and
 * turns that into a sentence before anything is uploaded.
 *
 * Unset is the DEFAULT and a perfectly good configuration -- most schemas
 * declare no such node -- so it passes, and says what unset means rather than
 * leaving the operator to infer it.
 *
 * When the path is set but cannot be verified (the collection names no schema,
 * or the schema cannot be read) this FAILS rather than passing quietly. The
 * operator deliberately asked for a field to be written; "could not check" is
 * never reported as clean anywhere else in this tool, and it must not be here
 * either. The message says it is unverified, not that it is wrong.
 */
async function attachmentFieldCheck(
  cfg: Config,
  client: OeqClient,
  schemaUuid: string,
): Promise<PreflightCheck> {
  const path = cfg.attachmentUuidPath;
  if (path === '') {
    return {
      label: 'Attachment field',
      pass: true,
      message:
        'OEQ_ATTACHMENT_UUID_PATH is not set, so no attachment-uuid field is written into item ' +
        'metadata. The attachment itself is unaffected -- attachments are linked through the ' +
        'attachment API, not through that field.',
    };
  }

  if (schemaUuid === '') {
    return {
      label: 'Attachment field',
      pass: false,
      message:
        `OEQ_ATTACHMENT_UUID_PATH is set to '${path}', but the target collection names no schema ` +
        `(or could not be read -- see the Collection check above), so it could not be confirmed ` +
        `that this path exists. Every item created would write to it.`,
    };
  }

  let schema: SchemaInfo;
  try {
    schema = await client.getSchema(schemaUuid);
  } catch (err) {
    return {
      label: 'Attachment field',
      pass: false,
      message:
        `OEQ_ATTACHMENT_UUID_PATH is set to '${path}', but schema ${schemaUuid} could not be read ` +
        `(${errorMessage(err)}), so it could not be confirmed that this path exists. Every item ` +
        `created would write to it.`,
    };
  }

  if (!schema.paths.has(path)) {
    return {
      label: 'Attachment field',
      pass: false,
      message:
        `OEQ_ATTACHMENT_UUID_PATH is set to '${path}', which schema ${schemaUuid} does not ` +
        `declare (it has ${schema.paths.size} valid paths). Every item created would write ` +
        `metadata to a node outside the schema. Correct it, or leave the variable blank -- blank ` +
        `writes no such field at all, which is right for a schema without one.`,
    };
  }

  return {
    label: 'Attachment field',
    pass: true,
    message: `each item's attachment uuid will be written to '${path}', which schema ${schemaUuid} declares.`,
  };
}
