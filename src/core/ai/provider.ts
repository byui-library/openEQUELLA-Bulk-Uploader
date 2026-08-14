// src/core/ai/provider.ts
import { ApiError } from '../errors.js';
import { describeReason } from '../errorReason.js';
import { instanceEndpoint } from '../instanceUrl.js';
import { redactSecret } from '../redact.js';
import { isLoopbackEndpoint } from './endpoint.js';

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
 *
 * `DEFAULT_MAX_TOKENS` below is the other half of this argument: a model that
 * fails to stop generating would otherwise burn the whole two minutes and time
 * out having produced text nobody sees.
 */
export const MODEL_TIMEOUT_MS = 120_000;

/** `setTimeout`'s ceiling, which `AbortSignal.timeout` inherits and enforces by
 *  throwing a RangeError. Checked here so a mistyped settings field produces a
 *  sentence about the setting instead. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Refuse a time limit this provider cannot honour.
 *
 * `AbortSignal.timeout` validates its own argument and throws `RangeError` or
 * `TypeError` -- neither of which is an `ApiError`, and `fill.ts` catches
 * `ApiError`. Zero is worse than either: it is accepted, and then every call in
 * the batch fails with "did not answer within 0 milliseconds", which reads as a
 * broken model rather than as a mistyped box.
 *
 * EXPORTED SO THE SETTINGS STORE CAN ASK BEFORE ANYTHING IS SAVED, the same
 * arrangement `assertUsableBudget` (slice.ts) and `assertUsableCap` (fill.ts)
 * already have. There is one rule for what a time limit may be, and the screen
 * that collects it and the code that uses it both read that one rule -- a copy
 * on the settings side would be free to accept a value this constructor then
 * refuses, four hundred rows later.
 */
export function assertUsableTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ApiError(
      `The model time limit must be a number of milliseconds between 1 and ` +
        `${MAX_TIMEOUT_MS}, but it was '${String(timeoutMs)}'. ` +
        `${MODEL_TIMEOUT_MS} is the default, and suits a local model on a slow machine.`,
      0,
      '',
    );
  }
}

/**
 * Sampling temperature.
 *
 * ZERO, BECAUSE INVENTION IS THE FAILURE THIS DESIGN EXISTS TO PREVENT.
 * `prompt.ts` spends its opening docblock on that point and then the request
 * used to ship with whatever the backend felt like: OpenAI defaults to 1.0 and
 * Ollama to 0.8, which is the setting most likely to produce exactly what the
 * prompt is written against. A catalogue description is not creative writing.
 */
const DEFAULT_TEMPERATURE = 0;

/**
 * Most tokens to generate for one cell.
 *
 * A catalogue description is a sentence or three -- the shipped house style is
 * a single line. Five hundred tokens is several times that and still nowhere
 * near any model's limit, so it never truncates a real answer, while a model
 * that gets stuck repeating itself is stopped in seconds rather than running to
 * its context limit and timing out.
 */
const DEFAULT_MAX_TOKENS = 500;

/** Most of a RESPONSE BODY to quote back in an error. Enough to recognise an
 *  HTML error page or a rate-limit message; not enough to paste a document into
 *  a spreadsheet note. */
const MAX_QUOTED_BODY = 200;

/*
 * The cause chain has a cap of its own, and it lives with `describeReason` in
 * `errorReason.ts` -- separate from the body cap above, because they bound
 * different things for different reasons: one is a hostile server's output,
 * the other a runtime's, and a reader following either comment should not land
 * on an argument about the other.
 */

export interface ProviderConfig {
  /**
   * Base URL up to and including /v1. Ollama, LM Studio, OpenAI, Azure.
   *
   * NOT put through `normaliseInstanceUrl`, deliberately, and the reason is
   * narrow: that function refuses plain http because openEQUELLA's sign-in
   * carries the password in the QUERY STRING. That is a fact about
   * openEQUELLA's API and it does not transfer here.
   *
   * WHAT DOES TRANSFER IS THE CREDENTIAL. A bearer key over plain http to a
   * remote host is readable by everything on the path, so exactly one
   * combination is refused -- http, plus a key, plus a host that is not this
   * machine (see `endpoint.ts`). Plain http to loopback stays free, which is
   * what every local runtime serves and what the local half of this design
   * rests on; https stays free; and a keyless remote http endpoint stays free,
   * because there is no credential to lose and the document text is the
   * operator's own call.
   */
  baseUrl: string;
  model: string;
  /** Absent for a local runtime, which needs no key. */
  apiKey?: string;
  /** Milliseconds to wait for one completion. See `MODEL_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Sampling temperature, or `null` to send none at all.
   *
   * OMITTABLE, NOT MERELY CONFIGURABLE. Reasoning models of the o1/o3 class
   * reject any temperature but their own default, and some gateways reject
   * parameters they do not recognise -- so a hardcoded value would make this
   * provider unusable against real endpoints. `null` sends nothing and lets the
   * backend decide; `undefined` takes `DEFAULT_TEMPERATURE`.
   */
  temperature?: number | null;
  /** Most tokens to generate, or `null` to send none. Same reasoning as
   *  `temperature`. `undefined` takes `DEFAULT_MAX_TOKENS`. */
  maxTokens?: number | null;
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
 * EVERY FAILURE THROWS AN `ApiError`, including a 200 whose body carries no
 * content, a configuration that will not parse, and a malformed setting. A
 * caller that cannot tell "the model said nothing" from "the call failed" would
 * write an empty description and call it success -- the exact shape of failure
 * this codebase has been bitten by repeatedly. `ApiError` specifically, and
 * without exception, because `fill.ts` puts the message on the row: a raw
 * `TypeError` escaping from here reaches the operator as
 * "Cannot read properties of null", which is not something anybody can act on.
 *
 * EVERY MESSAGE THAT LEAVES THIS CLASS IS REDACTED **BEFORE IT IS TRUNCATED**.
 * The order is the whole of it. Cutting a message to a length and then
 * redacting leaves the redactor a fragment of the key to match, matches
 * nothing, and lets a prefix walk out -- up to 163 characters of a
 * 164-character key. `tests/ai/provider.test.ts` searches for every prefix of
 * the key, not merely the whole thing, because a whole-string walker asserted
 * this class was clean while it was leaking.
 */
export class OpenAiCompatibleProvider {
  /** Built once, in the constructor, so a base URL that will not parse is a
   *  sentence about the setting rather than a `TypeError: Invalid URL` thrown
   *  from outside every try block, once per row. */
  private readonly endpoint: URL;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    try {
      this.endpoint = instanceEndpoint(config.baseUrl, '/chat/completions');
    } catch {
      throw new ApiError(
        // The address is quoted back because the operator typed it and needs to
        // see what arrived. Redacted first: they may have pasted a key into it.
        this.redact(
          `"${config.baseUrl}" is not a usable model address. It should look like ` +
            `http://localhost:11434/v1 for a local model, or https://api.openai.com/v1.`,
        ),
        0,
        '',
      );
    }

    // A BEARER KEY DOES NOT CROSS THE NETWORK IN CLEAR. See ProviderConfig.
    if (
      this.endpoint.protocol === 'http:' &&
      config.apiKey &&
      !isLoopbackEndpoint(config.baseUrl)
    ) {
      throw new ApiError(
        `The model address ${safeEndpoint(this.endpoint)} is not encrypted, and an API key ` +
          `would be sent to it in clear text where anything on the network can read it. ` +
          `Use https for a remote model. Plain http is fine for a model running on this ` +
          `computer, which needs no key.`,
        0,
        '',
      );
    }

    this.timeoutMs = config.timeoutMs ?? MODEL_TIMEOUT_MS;
    assertUsableTimeout(this.timeoutMs);
  }

  async complete(prompt: string): Promise<string> {
    const url = this.endpoint;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // The key goes HERE and nowhere else. Not in the URL, which reaches server
    // and proxy access logs that the header does not.
    if (this.config.apiKey) headers['authorization'] = `Bearer ${this.config.apiKey}`;

    // Its timer does not hold the event loop open, which matters for a CLI that
    // should exit when the work is done.
    const signal = AbortSignal.timeout(this.timeoutMs);

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
            body: JSON.stringify(this.requestBody(prompt)),
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
          // Redacted despite being built only from values this class made: the
          // endpoint carries the operator's own path, and gateways exist whose
          // published URL puts the key in it.
          this.redact(
            `The model at ${safeEndpoint(url)} did not answer within ` +
              `${describeDuration(this.timeoutMs)}. A local model on a slow machine can ` +
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
      // and hides the useful half underneath, and the redactor is passed INTO
      // that reader so every message is redacted before anything is cut.
      throw new ApiError(
        this.redact(
          `Could not reach the model at ${safeEndpoint(url)}: ` +
            `${describeReason(error, (text) => this.redact(text))}. ` +
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
        // redact THEN slice. The other order cuts the key in half and the
        // redactor matches nothing. See the class docblock.
        `The model returned ${res.status}. ${this.redact(body).slice(0, MAX_QUOTED_BODY)}`,
        res.status,
        this.redact(body),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ApiError(
        `The model at ${this.redact(safeEndpoint(url))} answered with something that was ` +
          `not JSON: ${this.redact(body).slice(0, MAX_QUOTED_BODY)}`,
        res.status,
        this.redact(body),
      );
    }

    // A REPLY THE MODEL WAS CUT OFF MID-WAY THROUGH IS NOT A VALUE. Checked
    // BEFORE the content, because a truncated reply is a perfectly well-formed
    // non-empty string and would otherwise sail through every check below,
    // through `cleanReply` as `ok`, and into a permanent catalogue record --
    // ending mid-sentence, with the ordinary "please check this" note and
    // nothing anywhere saying it was cut.
    //
    // The design says "Never a partial value" and `slice.ts` already refuses to
    // hand the model a mid-word fragment because "damaged text is where
    // invention starts". The same argument runs in this direction: a
    // half-sentence in a description field is text no reviewer can complete and
    // no reader can identify as incomplete. `DEFAULT_MAX_TOKENS` is 500 against
    // a house style of one line, so reaching it means something went wrong --
    // a model that would not stop, or a limit set far too low.
    //
    // ONLY THE EXPLICIT VALUE COUNTS. Several backends omit `finish_reason`
    // entirely, and treating absence as truncation would fail every call
    // against them.
    if (readFinishReason(parsed) === 'length') {
      throw new ApiError(
        `The model stopped in the middle of its answer because it hit its token limit. ` +
          `Nothing was written, because half a sentence in a catalogue record cannot be ` +
          `told from a whole one. Ask for a shorter answer, or raise the token limit.`,
        res.status,
        '',
      );
    }

    const content = readContent(parsed);
    if (content === null || content.trim() === '') {
      // Not an empty description. See the class comment: a caller that could
      // not tell these apart would write the blank and call it success.
      throw new ApiError('The model returned no text.', res.status, '');
    }
    return content.trim();
  }

  /**
   * The chat-completions request body.
   *
   * `temperature` and `max_tokens` are OMITTED when configured `null`, rather
   * than sent as null -- a parameter a backend rejects is worse than one it
   * defaults. See `ProviderConfig`.
   */
  private requestBody(prompt: string): Record<string, unknown> {
    const temperature = this.config.temperature === undefined
      ? DEFAULT_TEMPERATURE
      : this.config.temperature;
    const maxTokens = this.config.maxTokens === undefined
      ? DEFAULT_MAX_TOKENS
      : this.config.maxTokens;
    return {
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      ...(temperature === null ? {} : { temperature }),
      ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
    };
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
    try {
      // `Promise.race` subscribes to every element synchronously, so `expired`
      // is handled from this line onwards and a later abort cannot become an
      // unhandled rejection. No separate guard is needed, and one that was here
      // has been removed: it asserted a mechanism that does not exist.
      return await Promise.race([work(), expired]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private redact(text: string): string {
    return this.config.apiKey ? redactSecret(text, this.config.apiKey) : text;
  }
}

/**
 * The assistant's text, or null for any shape that does not carry one.
 *
 * EVERY STEP IS CHECKED, because `JSON.parse` returns whatever the server sent
 * and the optional-chaining version of this trusted the top of the tree:
 * `JSON.parse('null')` then `.choices?.[0]` throws `TypeError: Cannot read
 * properties of null` from outside every catch block, so a two-word body from a
 * confused proxy escaped as a raw TypeError with no redaction and nothing an
 * operator could act on.
 *
 * NULL IS NOT AN EMPTY DESCRIPTION. The caller throws on it. Returning `''`
 * here and letting it be written would be the failure this whole class is
 * arranged to prevent.
 */
function readContent(parsed: unknown): string | null {
  const choices = readProperty(parsed, 'choices');
  if (!Array.isArray(choices)) return null;
  const message = readProperty(choices[0], 'message');
  const content = readProperty(message, 'content');
  return typeof content === 'string' ? content : null;
}

/**
 * Why the model stopped, or null where it did not say.
 *
 * `stop` is a finished answer, `length` is one cut off at the token limit, and
 * anything else -- `content_filter`, `tool_calls`, a vendor's own word -- is
 * returned as it arrived rather than mapped, so the caller decides. Every step
 * is checked for the same reason `readContent` checks every step: this is a
 * server's output, not this code's.
 */
function readFinishReason(parsed: unknown): string | null {
  const choices = readProperty(parsed, 'choices');
  if (!Array.isArray(choices)) return null;
  const reason = readProperty(choices[0], 'finish_reason');
  return typeof reason === 'string' ? reason : null;
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
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

