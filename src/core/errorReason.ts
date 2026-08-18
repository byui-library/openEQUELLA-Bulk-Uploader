/**
 * What actually went wrong, read through an error's `cause` chain.
 *
 * ## WHY `err.message` IS NOT THE ANSWER
 *
 * Node's own `fetch` throws `TypeError: fetch failed` and puts the real reason
 * -- `getaddrinfo ENOTFOUND oeq.example.edu`, `connect ECONNREFUSED
 * 127.0.0.1:11434`, a TLS failure -- on `cause`. So the eleven places in this
 * codebase that read
 *
 *     error instanceof Error ? error.message : String(error)
 *
 * preserve a reason that says nothing, and the operator is told "fetch failed"
 * for a wrong address, a stopped server and an expired certificate alike. Three
 * different problems, three different fixes, one useless sentence. That is a
 * live defect at `client.ts`, through which every API request this tool makes
 * passes.
 *
 * ## THE REDACTOR IS A PARAMETER, NOT A STEP THE CALLER TAKES AFTERWARDS
 *
 * The result is capped, and redacting a capped string is too late: the cut
 * lands inside the secret and the redactor is handed a fragment it cannot
 * match, so a prefix survives. That is not hypothetical -- it shipped in
 * `ai/provider.ts` and leaked up to 163 characters of a 164-character API key.
 * Each message is redacted as it is read, and the joined string again before it
 * is cut, so no boundary can fall inside a secret. Callers with no secret to
 * hide omit the argument.
 */

/** Longest reason to return. It ends up in a spreadsheet note and a log line,
 *  and a runtime that dumps a stack trace into its message must not paste it
 *  into either. */
const MAX_REASON = 200;

/**
 * How far up the chain to read.
 *
 * Node wraps a network failure once; a gateway or proxy client can wrap it
 * twice more. Four covers those and stops: nothing five levels down diagnoses
 * anything, and a chain that cycles back on itself would otherwise spin for
 * ever.
 */
const MAX_CAUSE_DEPTH = 4;

/** Said when there is nothing readable at all, rather than an empty string --
 *  a message ending in ": " reads as a bug in the tool. */
export const UNSTATED_REASON = 'the connection failed for an unstated reason';

/**
 * `error` and everything under its `cause`, joined shallowest-first.
 *
 * EXACT DUPLICATES ARE DROPPED. `new Error(cause.message, { cause })` is a real
 * and common wrapper, and it would otherwise print its message twice in a note
 * somebody has to read. Only whole-string equality is compared: a wrapper that
 * CONTAINS its cause's message ("fetch failed: connect ECONNREFUSED" over
 * "connect ECONNREFUSED") keeps both, deliberately, because deciding which of
 * two overlapping strings to discard is how a reader loses the half that
 * mattered.
 */
export function describeReason(
  error: unknown,
  redact: (text: string) => string = (text) => text,
): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    const message = redact(current instanceof Error ? current.message : String(current));
    if (message !== '' && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  const reason = redact(parts.join(': '));
  return reason === '' ? UNSTATED_REASON : reason.slice(0, MAX_REASON);
}

/** How much of a server's error body is worth putting in a message a person
 *  reads in a dialog. Enough for openEQUELLA's own one-line explanations,
 *  short enough that an HTML page does not become the message. */
const MAX_BODY_EXCERPT = 200;

/**
 * What a server actually answered, in one line.
 *
 * The response half of `describeReason`, and it exists for the same reason:
 * every API request this tool makes passes through one place, and that place
 * reported `GET /api/collection?... failed` -- no status, no reason -- for a
 * 401, a 403, a 500 and a load balancer's 502 alike. The status and body were
 * captured on the `ApiError` all along, but Electron's IPC serialises only a
 * message across the boundary, so the desktop app could never show them.
 *
 * REDACT-THEN-TRUNCATE IS NOT NEEDED HERE AND THE ABSENCE IS DELIBERATE: this
 * body is a RESPONSE, and no secret this tool holds is echoed into one. The
 * two endpoints that carry a credential -- `/api/auth/login` and
 * `/oauth/access_token` -- do their own redaction in `passwordAuth.ts` and
 * `authCode.ts`, on both the message and the body, before anything reaches
 * here. Do not add a redactor that has no secret to redact: it would search
 * for the empty string.
 */
export function describeResponse(res: { status: number; statusText?: string }, body: string): string {
  const status = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
  // Tags stripped and whitespace collapsed: openEQUELLA answers with an HTML
  // error page, and a wall of markup in a dialog is worse than none at all.
  const text = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return status;
  const excerpt = text.length > MAX_BODY_EXCERPT ? `${text.slice(0, MAX_BODY_EXCERPT)}…` : text;
  return `${status} — ${excerpt}`;
}
