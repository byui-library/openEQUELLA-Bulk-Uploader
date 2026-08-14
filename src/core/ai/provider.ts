// src/core/ai/provider.ts
import { ApiError } from '../errors.js';
import { instanceEndpoint } from '../instanceUrl.js';
import { redactSecret } from '../redact.js';

/**
 * How long to wait for one completion before giving up.
 *
 * TWO MINUTES, AND THE NUMBER IS ARGUED FOR RATHER THAN INHERITED. The two
 * configurations this provider serves differ by more than an order of
 * magnitude, and the usual thirty-second web default fits only one of them:
 *
 * - A hosted frontier model answers a request this size in single-digit
 *   seconds. Two minutes is twenty times the headroom it needs, and it is only
 *   reached when something is genuinely wrong.
 * - A quantised 7B on a CPU is the configuration this feature exists to make
 *   possible, and it is slow in BOTH halves of the call. Reading a prompt of a
 *   few thousand characters is tens of seconds on its own; generating a
 *   paragraph at a handful of tokens a second is tens more. Ninety seconds is
 *   an ordinary, entirely healthy result there.
 *
 * ABANDONING A WORKING MODEL IS THE EXPENSIVE MISTAKE. The compute is already
 * spent, the cell is left blank, and the note tells the operator the model
 * timed out -- which reads as "this does not work" for a configuration that
 * does. So the default is set above the slow case rather than near the fast
 * one.
 *
 * IT IS NOT LARGER THAN THAT, either. One call runs per eligible row, in order,
 * with a run cap in the hundreds; at this limit a run in which every call hangs
 * takes hours rather than for ever, and each row still says what happened.
 * A configuration slower than this -- a 70B on CPU, a machine under load --
 * raises `timeoutMs` rather than having everybody else wait for it.
 */
export const MODEL_TIMEOUT_MS = 120_000;

/** Most of a response body to quote back in an error. Enough to recognise an
 *  HTML error page or a rate-limit message; not enough to paste a document. */
const MAX_QUOTED = 200;

/** How far up a `cause` chain to read. Node wraps a network failure once;
 *  a gateway client can wrap it twice more. Bounded so a cyclic chain cannot
 *  spin. */
const MAX_CAUSE_DEPTH = 4;

export interface ProviderConfig {
  /**
   * Base URL up to and including /v1. Ollama, LM Studio, OpenAI, Azure.
   *
   * NOT put through `normaliseInstanceUrl`, deliberately. That function refuses
   * plain http, because openEQUELLA's sign-in carries the password in the query
   * string -- a fact about openEQUELLA's API, not about HTTP. Every local model
   * runtime serves plain http on loopback (`http://localhost:11434`), nothing
   * is sent there but document text the operator already holds, and the whole
   * local half of this design rests on that working. `instanceEndpoint` does no
   * such check, which is why it is the one used here.
   */
  baseUrl: string;
  model: string;
  /** Absent for a local runtime, which needs no key. */
  apiKey?: string;
  /** Milliseconds to wait for one completion. See `MODEL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * One HTTP call to an OpenAI-compatible chat-completions endpoint.
 *
 * ONE WIRE FORMAT, MANY PROVIDERS. Ollama, LM Studio, llama.cpp, OpenAI, Azure
 * OpenAI, Groq, Together and OpenRouter all speak this shape, so "any of the
 * major LLMs" is a base URL rather than new code. Anthropic and Google do not
 * and would each be a separate class behind the same method.
 *
 * KNOWS NOTHING ABOUT DOCUMENTS. It takes a prompt and returns text. What to
 * send and what the answer means belong to prompt.ts and fill.ts.
 *
 * EVERY FAILURE THROWS, including a 200 whose body carries no content. A caller
 * that cannot tell "the model said nothing" from "the call failed" would write
 * an empty description and call it success -- the exact shape of failure this
 * codebase has been bitten by repeatedly.
 *
 * EVERY MESSAGE THAT LEAVES THIS CLASS IS REDACTED, without exception, and
 * `tests/ai/provider.test.ts` walks every string reachable from a thrown error
 * to prove it. The message ends up in a spreadsheet note the operator emails
 * around asking for help, so one un-redacted path is one leaked key.
 */
export class OpenAiCompatibleProvider {
  constructor(
    private readonly config: ProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(prompt: string): Promise<string> {
    const url = instanceEndpoint(this.config.baseUrl, '/chat/completions');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // The key goes HERE and nowhere else. Not in the URL, which reaches server
    // and proxy access logs that the header does not.
    if (this.config.apiKey) headers['authorization'] = `Bearer ${this.config.apiKey}`;

    const timeoutMs = this.config.timeoutMs ?? MODEL_TIMEOUT_MS;
    // `AbortSignal.timeout` exists from Node 17.3 and this process is Node 22,
    // so there is nothing to fall back to. Its timer does not hold the event
    // loop open, which matters for a CLI that should exit when the work is done.
    const signal = AbortSignal.timeout(timeoutMs);

    let body: string;
    let res: Response;
    try {
      ({ res, body } = await this.raceTheClock(
        async () => {
          const response = await this.fetchImpl(url, {
            method: 'POST',
            headers,
            // Handed to fetch as well as raced below. The race settles THIS
            // process's promise; the signal is what actually cancels the
            // request and frees the socket.
            signal,
            body: JSON.stringify({
              model: this.config.model,
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          // Reading the body is inside the limit too. A response whose stream
          // stops half way is the same hang arriving one step later.
          return { res: response, body: await response.text() };
        },
        signal,
      ));
    } catch (error) {
      // A TIMEOUT IS NOT AN UNREACHABLE ADDRESS, and must not read like one.
      // The endpoint answered and then stopped; "check the address" would send
      // the operator to the one place the problem is not.
      if (signal.aborted) {
        throw new ApiError(
          this.redact(
            `The model at ${safeEndpoint(url)} did not answer within ` +
              `${describeDuration(timeoutMs)}. A local model on a slow machine can ` +
              `legitimately take longer -- allow more time, or use a smaller model.`,
          ),
          0,
          '',
        );
      }
      // THE REASON IS PRESERVED, not replaced by a single sentence that covers
      // DNS failure, a refused connection and a TLS error alike -- three
      // different problems with three different fixes. It is read through the
      // cause chain because Node's own fetch throws `TypeError: fetch failed`
      // and hides the useful half underneath, and it is redacted because it is
      // a string from somewhere this code does not control.
      throw new ApiError(
        this.redact(
          `Could not reach the model at ${safeEndpoint(url)}: ${describeReason(error)}. ` +
            `Check the address and that the model is running.`,
        ),
        0,
        '',
      );
      // The original error is deliberately NOT attached as `cause`: it is an
      // object this code did not build, redaction cannot reach inside it, and
      // every consumer of a thrown error here walks `cause`.
    }

    if (!res.ok) {
      throw new ApiError(
        this.redact(`The model returned ${res.status}. ${body.slice(0, MAX_QUOTED)}`),
        res.status,
        this.redact(body),
      );
    }

    let parsed: { choices?: { message?: { content?: unknown } }[] };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new ApiError(
        this.redact(
          `The model at ${safeEndpoint(url)} answered with something that was not JSON: ` +
            `${body.slice(0, MAX_QUOTED)}`,
        ),
        res.status,
        this.redact(body),
      );
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      // Not an empty description. See the class comment: a caller that could
      // not tell these apart would write the blank and call it success.
      throw new ApiError('The model returned no text.', res.status, '');
    }
    return content.trim();
  }

  /**
   * `work()`, but settled by the time limit even if the fetch implementation
   * ignores the abort signal.
   *
   * THE SIGNAL ALONE IS NOT ENOUGH. `fetch` is injectable here -- that is what
   * makes this class testable -- and an implementation that ignores `signal`
   * hangs for ever however correct the signal is. Racing guarantees the promise
   * settles; the signal, sent alongside, is what stops the real request.
   */
  private async raceTheClock<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort: (() => void) | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('timed out'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // Attached before the race so that an abort arriving AFTER the work has
    // already won is a handled rejection rather than an unhandled one, which
    // Node reports as a process-level warning and, in some configurations,
    // exits over.
    expired.catch(() => {});
    try {
      return await Promise.race([work(), expired]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private redact(text: string): string {
    return this.config.apiKey ? redactSecret(text, this.config.apiKey) : text;
  }
}

/** Origin + path, never the query string. The same discipline as the
 *  `safeEndpoint()` methods in auth.ts and passwordAuth.ts: an operator-typed
 *  base URL is not this code's to trust, and origin excludes any userinfo. */
function safeEndpoint(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** Milliseconds in words an operator can act on. */
function describeDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} milliseconds`;
}

/**
 * What actually went wrong, read through the `cause` chain.
 *
 * Node's fetch throws `TypeError: fetch failed` and puts `getaddrinfo
 * ENOTFOUND` or `connect ECONNREFUSED` on `cause`, so reading `message` alone
 * preserves a reason that says nothing. Duplicates are dropped -- a wrapper
 * that copies its cause's message would otherwise print it twice.
 */
function describeReason(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message !== '' && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  const reason = parts.join(': ');
  return reason === '' ? 'the connection failed for an unstated reason' : reason.slice(0, MAX_QUOTED);
}
