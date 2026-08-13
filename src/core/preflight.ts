import type { AuthProvider } from './auth.js';
import type { CollectionList, CurrentUser, OeqClient } from './client.js';
import { ApiError } from './errors.js';
import type { AuthMode, Config } from './config.js';
import type { SchemaInfo } from './discovery.js';
import { normaliseInstanceUrl } from './instanceUrl.js';
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
 * The verdict line both front ends end their report with.
 *
 * Shared for the same reason `runPreflight` itself is: the CLI and the MCP
 * server had a copy of this sentence each, which is how two surfaces that are
 * meant to say exactly the same thing start saying different things.
 *
 * It NAMES the failing checks. The report is now nine lines long, so "one or
 * more checks failed -- see above" asks the reader to scroll back and re-scan
 * for the ones marked FAIL. That is the moment a real failure gets skimmed
 * past, and this report exists precisely to be read by someone at another
 * institution who cannot ask us what it meant.
 */
export function summarise(result: PreflightResult): string {
  const failed = result.checks.filter((c) => !c.pass);
  if (failed.length === 0) return 'All checks passed.';
  return (
    `${failed.length} of ${result.checks.length} checks failed -- see above: ` +
    `${failed.map((c) => c.label).join(', ')}.`
  );
}

/**
 * The read-only pre-flight both `oeq-upload check` (cli/index.ts) and
 * `oeq_check` (mcp/index.ts) run before any upload is attempted. Shared here
 * so the two front ends can't drift into checking different things or
 * reporting them differently -- they're meant to be exactly the same checks,
 * just rendered two ways.
 *
 * IT IS ALSO THE COMPATIBILITY PROBE. Only BYU-Idaho's instances were
 * available while this tool was made institution-agnostic, so the first site
 * to run it anywhere else is the real test of that work -- and this report is
 * how they tell us what broke without us having access to their instance.
 * That is why every message says what a failure MEANS for a real run rather
 * than only what was observed: a line an operator cannot act on sends them to
 * us, which is the outcome the report exists to avoid.
 *
 * Creates nothing. In order:
 *   1. The configured address is https (or loopback) -- read from `Config`,
 *      calls nothing. openEQUELLA takes a password as a query parameter, so
 *      this is the precondition for password sign-in being safe at all.
 *   2. A usable token exists (and if not, stops after the sign-in method
 *      below -- nothing further can succeed without one, and every failure
 *      past that point would just be a confusing echo of the same root
 *      cause).
 *   3. Which sign-in method was used, and whether it worked. Reported on
 *      BOTH paths: a site that believes it is using a password but fell
 *      through to an OAuth mode should learn it here, not from
 *      openEQUELLA's "No OAuth client can be found with the supplied
 *      client_id (null)".
 *   4. `GET /api/content/currentuser` -- who created items will be owned by.
 *      This is the entire point of the authorization-code flow: confirming
 *      it *before* a 5.5GB batch runs, not after.
 *   5. `GET /api/collection/{uuid}` -- does the target collection exist on
 *      THIS host. The collection UUID in `Config` is identical between test
 *      and production, so `baseUrl` is the only thing telling them apart --
 *      this check is what catches OEQ_BASE_URL pointed at the wrong one.
 *   6. `GET /api/collection?privilege=CREATE_ITEM` -- how many collections
 *      this account can create in AT ALL. Zero is a real, diagnosable state,
 *      not an error: the account authenticated and can contribute nowhere,
 *      which is what a viewer-only account looks like.
 *   7. ...and whether the target collection is one of them; if not, which
 *      ones are. Same request as 6, read a second way.
 *   8. `GET /api/schema/{uuid}` -- does `OEQ_ATTACHMENT_UUID_PATH` name a
 *      node this schema has.
 *   9. ...and does that schema declare an item name path at all. Same
 *      request as 8. This is the highest-value line in the report: without
 *      one, `findDuplicates` reports could-not-check for EVERY row.
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

  checks.push(httpsCheck(cfg));

  let signedIn = false;
  try {
    await auth.getToken();
    signedIn = true;
    checks.push({ label: 'Token', pass: true, message: 'present and usable.' });
  } catch (err) {
    const message = errorMessage(err).split(DEFAULT_LOGIN_HINT).join(loginHint);
    checks.push({ label: 'Token', pass: false, message });
  }

  // Reported on both paths, and BEFORE the early return below: naming the
  // method that just failed is most of this check's value -- see signInCheck.
  checks.push(signInCheck(cfg, signedIn));

  if (!signedIn) {
    // Nothing below can succeed without a token, and every failure past this
    // point would just be a confusing echo of the same root cause.
    return { ok: false, checks };
  }

  try {
    checks.push(identityCheck(await client.currentUser()));
  } catch (err) {
    checks.push({ label: 'Identity', pass: false, message: errorMessage(err) });
  }

  // Captured for the attachment-field and duplicate-detection checks below:
  // choosing a collection also determines its schema, so nothing has to be
  // configured twice.
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

  // ONE request, read two ways: "can this account create anything at all"
  // and "is the target one of them" are different questions with different
  // remedies, but the same answer already contains both. Issuing it twice
  // would double the cost for no new information, and could report two
  // different truths if the answer changed between them.
  let creatable: CollectionList | null = null;
  let creatableError = '';
  try {
    creatable = await client.listCollections({ privilege: 'CREATE_ITEM', length: 100 });
  } catch (err) {
    creatableError = errorMessage(err);
  }

  checks.push(collectionsAvailableCheck(creatable, creatableError));

  if (creatable === null) {
    checks.push({ label: 'Permission', pass: false, message: creatableError });
  } else {
    const rows = creatable.collections;
    const target = rows.find((c) => c.uuid === cfg.collectionUuid);
    if (target) {
      checks.push({
        label: 'Permission',
        pass: true,
        message: `CREATE_ITEM confirmed on '${target.name}'.`,
      });
    } else if (rows.length > 0) {
      checks.push({
        label: 'Permission',
        pass: false,
        message:
          `CREATE_ITEM not confirmed on ${cfg.collectionUuid}. Collections you CAN contribute to:\n` +
          rows.map((c) => `    - ${c.name} (${c.uuid})`).join('\n'),
      });
    } else if (creatable.withheld) {
      // Not "you hold it on nothing": the server said collections exist and
      // handed none over. See collectionsAvailableCheck.
      checks.push({
        label: 'Permission',
        pass: false,
        message:
          `CREATE_ITEM could not be confirmed on ${cfg.collectionUuid}, or on anything else: the ` +
          `server withheld the whole list (see the Collections available check above). This says ` +
          `nothing about what this account can do -- only that nobody asked as this account.`,
      });
    } else {
      checks.push({
        label: 'Permission',
        pass: false,
        message: 'CREATE_ITEM not confirmed on any collection for this user.',
      });
    }
  }

  // Read ONCE and shared by the two checks below, for the same reason as the
  // collection list above -- and because two reads could disagree.
  let schema: SchemaInfo | null = null;
  let schemaError = '';
  if (schemaUuid !== '') {
    try {
      schema = await client.getSchema(schemaUuid);
    } catch (err) {
      schemaError = errorMessage(err);
    }
  }

  checks.push(attachmentFieldCheck(cfg, schemaUuid, schema, schemaError));
  checks.push(duplicateDetectionCheck(schemaUuid, schema, schemaError));

  return { ok: checks.every((c) => c.pass), checks };
}

/**
 * That the configured address is one credentials can safely be sent to.
 *
 * Reads `Config` and calls nothing, which is why it runs first: it is the
 * precondition for password sign-in being safe at all, since openEQUELLA
 * takes the password as a QUERY PARAMETER (confirmed in schema/swagger.json)
 * and over http it would therefore travel in clear text in the request line.
 * `normaliseInstanceUrl` is the single place that rule lives; this check
 * reports its verdict rather than restating it.
 *
 * A LOOPBACK ADDRESS IS EXEMPT, and the message says so out loud. Traffic to
 * `localhost`/`127.0.0.0/8`/`::1` never leaves the machine, so the
 * interception this rule exists to prevent cannot occur -- the same reasoning
 * browsers use to treat loopback as a secure context. Stating the exemption
 * in the report matters as much as making it: a bare "ok" would read as
 * licence to use http against a real host.
 *
 * Note that `normaliseInstanceUrl` ITSELF still rejects loopback over http,
 * so `OEQ_AUTH_MODE=password` against `http://localhost` fails when
 * `UsernamePasswordAuth` is constructed, before this report is ever built.
 * The exemption is therefore only ever visible in the OAuth modes, where no
 * password is put in a URL at all.
 */
function httpsCheck(cfg: Config): PreflightCheck {
  if (isLoopback(cfg.baseUrl)) {
    return {
      label: 'HTTPS',
      pass: true,
      message:
        `OEQ_BASE_URL is '${cfg.baseUrl}', a loopback address -- its traffic never leaves this ` +
        `machine, so https is not required for it. Any other host MUST use https: openEQUELLA ` +
        `takes your password as part of the web address when signing in, so an unencrypted ` +
        `connection would expose it.`,
    };
  }

  try {
    const normalised = normaliseInstanceUrl(cfg.baseUrl);
    return {
      label: 'HTTPS',
      pass: true,
      message:
        `OEQ_BASE_URL is '${normalised}', which uses https. openEQUELLA takes your password as ` +
        `part of the web address when signing in, so this is what keeps it from travelling in ` +
        `clear text.`,
    };
  } catch (err) {
    return {
      label: 'HTTPS',
      pass: false,
      message:
        `OEQ_BASE_URL is '${cfg.baseUrl}'. ${errorMessage(err)} ` +
        `Password sign-in (OEQ_AUTH_MODE=password) refuses to start against this address, and ` +
        `anything else sent to it would travel unencrypted.`,
    };
  }
}

function isLoopback(raw: string): boolean {
  let host: string;
  try {
    ({ hostname: host } = new URL(raw.trim()));
  } catch {
    // Not a parseable address at all -- that is the https check's failure to
    // report, with normaliseInstanceUrl's own wording, not this helper's.
    return false;
  }
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** How each `OEQ_AUTH_MODE` should be described to someone who did not set it. */
const AUTH_MODE_DESCRIPTIONS: Record<AuthMode, string> = {
  code: 'an OAuth authorization code, signed in interactively and cached',
  client_credentials: 'OAuth client credentials, from OEQ_CLIENT_ID and OEQ_CLIENT_SECRET',
  password: 'a username and password, from OEQ_USERNAME and OEQ_PASSWORD',
};

/**
 * WHICH sign-in method was used, and whether it worked.
 *
 * `OEQ_AUTH_MODE` defaults to `code` when unset (see config.ts), which makes
 * the failure this check exists for entirely silent: a site fills in
 * OEQ_USERNAME and OEQ_PASSWORD, never sets OEQ_AUTH_MODE, and gets the OAuth
 * path anyway. openEQUELLA answers that with "No OAuth client can be found
 * with the supplied client_id (null)" -- which names neither the variables
 * they set nor the one they didn't, and reads like a server misconfiguration
 * rather than a two-word fix in their own .env.
 *
 * So this reports on the SUCCESS path too. Knowing which of three methods a
 * working sign-in actually used is what makes a later failure diagnosable,
 * and it is a line nobody has to ask us for.
 *
 * Names the variables, never their values -- `cfg.password` is never rendered.
 */
function signInCheck(cfg: Config, signedIn: boolean): PreflightCheck {
  const described = `OEQ_AUTH_MODE=${cfg.authMode}, i.e. ${AUTH_MODE_DESCRIPTIONS[cfg.authMode]}`;

  if (signedIn) {
    return {
      label: 'Sign-in method',
      pass: true,
      message: `signed in with ${described}.`,
    };
  }

  // The credentials-set-but-unused case. Only worth saying when both are
  // present: one alone is as likely to be a leftover as an intention.
  const passwordIgnored =
    cfg.authMode !== 'password' && cfg.username !== '' && cfg.password !== ''
      ? ` OEQ_USERNAME and OEQ_PASSWORD are set but are NOT being used in this mode -- set ` +
        `OEQ_AUTH_MODE=password to sign in with them. openEQUELLA reports this as "No OAuth ` +
        `client can be found with the supplied client_id (null)", which names neither variable.`
      : '';

  return {
    label: 'Sign-in method',
    pass: false,
    message:
      `sign-in did not succeed with ${described} -- see the Token check above for why.` +
      passwordIgnored,
  };
}

/**
 * Who created items will be owned by -- and, first, whether anybody is signed
 * in at all.
 *
 * A SUCCESSFUL CALL IS NOT PROOF OF SIGN-IN, which is what this check used to
 * treat it as. openEQUELLA never answers an unauthenticated request with 401:
 * it answers 200 as the guest identity (client.ts's `CurrentUser.guest`), so
 * `pass: true` on any answer at all produced
 *
 *     Identity   ok   logged in as guest ( ). Created items will be owned by this user.
 *
 * A PASS, from the one report built to tell a new institution whether this
 * tool works against their instance. Nothing anywhere else in the report would
 * have said otherwise either: the collection list comes back empty for a guest
 * too, which reads as a privilege to ask an administrator for.
 *
 * So guest FAILS, and the message says what it means for a real run -- that
 * nothing can be created, and that the sign-in step did not do what it
 * appeared to.
 */
function identityCheck(user: CurrentUser): PreflightCheck {
  if (user.guest) {
    return {
      label: 'Identity',
      pass: false,
      message:
        `openEQUELLA answered as the GUEST identity ('${user.username}'), which means this ` +
        `session is NOT signed in. Nothing can be created: every contribution would be refused, ` +
        `and the list of collections comes back empty even where collections exist. This is not ` +
        `an error the server reports -- an unauthenticated request is answered with a normal, ` +
        `plausible-looking response and no 401 -- so a sign-in that appeared to succeed can end ` +
        `up here. Check the sign-in method above and sign in again.`,
    };
  }
  return {
    label: 'Identity',
    pass: true,
    message: `logged in as ${user.username} (${user.firstName} ${user.lastName}). Created items will be owned by this user.`,
  };
}

/**
 * How many collections this account can create in AT ALL.
 *
 * ZERO IS A REAL, DIAGNOSABLE STATE, not an error: the account authenticated
 * perfectly and can contribute nowhere, which is exactly what a viewer-only
 * account looks like. Said plainly, it points at an administrator and a
 * privilege; left to be inferred from the Permission check below, it looks
 * like a wrong collection uuid, and a site debugs the wrong layer.
 *
 * A list that could NOT BE READ must never render as an empty one. Those two
 * have no fix in common -- one is a permission to be granted, the other is a
 * host that cannot be reached -- so the failure says which it is.
 *
 * AND NEITHER IS A LIST THE SERVER WITHHELD. There is a third state, and it
 * arrives as a perfectly successful 200: `available: 29` with zero rows,
 * measured against the live test instance with no credentials at all. Reported
 * as zero it reads as a privilege to go and ask an administrator for -- so a
 * site would ask for one they already hold, and never look at their sign-in.
 * See `CollectionList.withheld`.
 */
function collectionsAvailableCheck(
  creatable: CollectionList | null,
  error: string,
): PreflightCheck {
  if (creatable === null) {
    return {
      label: 'Collections available',
      pass: false,
      message:
        `the list of collections you can contribute to could not be read (${error}), so it is ` +
        `unknown whether this account can create items anywhere. This is not the same as having ` +
        `none -- it says nothing either way.`,
    };
  }

  if (creatable.withheld) {
    return {
      label: 'Collections available',
      pass: false,
      message:
        `the server reports that ${creatable.available} collection(s) exist for this query and ` +
        `returned NONE of them. That is what openEQUELLA does for a session that is not signed ` +
        `in: it answers 200 with an empty list rather than refusing the request, so this looks ` +
        `exactly like an account with no collections and is not one. See the Identity check ` +
        `above -- if it names the guest user, nothing here is a permissions problem and no ` +
        `administrator needs to grant anything. Sign in and run this again.`,
    };
  }

  if (creatable.collections.length === 0) {
    return {
      label: 'Collections available',
      pass: false,
      message:
        'this account holds CREATE_ITEM on no collection, so it can contribute nowhere and no ' +
        'upload can succeed. Sign-in itself worked, so this is a permission to be granted by an ' +
        'openEQUELLA administrator, not a wrong address or a wrong collection uuid. An account ' +
        'that can only view looks exactly like this.',
    };
  }

  return {
    label: 'Collections available',
    pass: true,
    message:
      `${creatable.collections.length} collection(s) accept contributions from this account: ` +
      creatable.collections.map((c) => `${c.name} (${c.uuid})`).join(', '),
  };
}

/**
 * Whether the target collection's schema declares an item name path.
 *
 * THE HIGHEST-VALUE LINE IN THIS REPORT. `findDuplicates` matches on that
 * path and issues no search without one -- it reports could-not-check for
 * EVERY pending row instead (see duplicates.ts, and the design doc it cites:
 * returning "clean" from a check that never ran has shipped from this
 * codebase once already). A site should learn that here, once, before a
 * batch, rather than as one warning per row partway through one.
 *
 * Names the path on the way through. `MWDL/title` was hardcoded here once and
 * is correct at exactly one institution, so a report that does not show which
 * path it will actually search would hide the very regression this work
 * exists to prevent.
 *
 * Unverifiable FAILS, and says it is unverified rather than wrong -- the same
 * rule as attachmentFieldCheck below. "Could not check" is not reported as
 * clean anywhere else in this tool.
 */
function duplicateDetectionCheck(
  schemaUuid: string,
  schema: SchemaInfo | null,
  schemaError: string,
): PreflightCheck {
  if (schemaUuid === '') {
    return {
      label: 'Duplicate detection',
      pass: false,
      message:
        'the target collection names no schema (or could not be read -- see the Collection check ' +
        'above), so it could not be confirmed which field holds an item title. Unconfirmed is ' +
        'not the same as broken, but until it is resolved every row would be reported as ' +
        '"could not check" rather than as clean.',
    };
  }

  if (schema === null) {
    return {
      label: 'Duplicate detection',
      pass: false,
      message:
        `schema ${schemaUuid} could not be read (${schemaError}), so it could not be confirmed ` +
        `which field holds an item title. Unconfirmed is not the same as broken, but until it ` +
        `is resolved every row would be reported as "could not check" rather than as clean.`,
    };
  }

  if (!schema.titleHeader) {
    return {
      label: 'Duplicate detection',
      pass: false,
      message:
        `schema ${schemaUuid} declares no item name path, so there is nothing to match an ` +
        `existing item's title against. Every row in every batch would be reported as "could ` +
        `not check" -- never as a duplicate, and never as clean -- and each would have to be ` +
        `checked by hand before uploading. Ask an openEQUELLA administrator to set the schema's ` +
        `item name path to the field that holds the title.`,
    };
  }

  return {
    label: 'Duplicate detection',
    pass: true,
    message:
      `existing items will be matched on '${schema.titleHeader}', which schema ${schemaUuid} ` +
      `declares as the item name path. A row whose title already exists in the collection will ` +
      `be reported before anything is uploaded.`,
  };
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
 *
 * Takes the already-read schema rather than fetching its own: the duplicate
 * detection check needs the same document, and two reads could disagree.
 * `schema` is null when there was nothing to read (`schemaUuid` empty) or the
 * read failed, which `schemaError` then explains.
 */
function attachmentFieldCheck(
  cfg: Config,
  schemaUuid: string,
  schema: SchemaInfo | null,
  schemaError: string,
): PreflightCheck {
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

  if (schema === null) {
    return {
      label: 'Attachment field',
      pass: false,
      message:
        `OEQ_ATTACHMENT_UUID_PATH is set to '${path}', but schema ${schemaUuid} could not be read ` +
        `(${schemaError}), so it could not be confirmed that this path exists. Every item ` +
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
