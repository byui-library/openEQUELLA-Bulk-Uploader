import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../../src/core/errors.js';
import {
  MAX_TIMEOUT_SECONDS,
  MODEL_TIMEOUT_MS,
  OpenAiCompatibleProvider,
  timeoutSecondsProblem,
} from '../../src/core/ai/provider.js';

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

/** A fetch double that records the URLs it was given. */
function urlSpy(response: () => Response) {
  const seen: string[] = [];
  const impl = vi.fn(async (input: string | URL) => {
    seen.push(String(input));
    return response();
  }) as unknown as typeof fetch;
  return { seen, impl };
}

/** A fetch double that records the headers it was given, lowercased by `Headers`. */
function headerSpy(response: () => Response) {
  let headers: Record<string, string> = {};
  const impl = vi.fn(async (_i: string | URL, init?: RequestInit) => {
    headers = Object.fromEntries(new Headers(init?.headers).entries());
    return response();
  }) as unknown as typeof fetch;
  return {
    get headers() {
      return headers;
    },
    impl,
  };
}

describe('OpenAiCompatibleProvider', () => {
  it('posts to the chat-completions path under the configured base url', async () => {
    const { seen, impl } = urlSpy(() => reply('A description.'));
    const p = new OpenAiCompatibleProvider(
      { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      impl,
    );
    await p.complete('prompt');
    expect(seen[0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  /**
   * A prefixed host is real: openEQUELLA is commonly deployed under one, and so
   * are self-hosted model gateways.
   */
  it('keeps a path prefix on the base url', async () => {
    const { seen, impl } = urlSpy(() => reply('x'));
    await new OpenAiCompatibleProvider({ baseUrl: 'https://host/gateway/v1', model: 'm' }, impl).complete(
      'p',
    );
    expect(seen[0]).toBe('https://host/gateway/v1/chat/completions');
  });

  /**
   * The local case is PLAIN HTTP, by default, on every local runtime there is:
   * Ollama serves http://localhost:11434 and LM Studio http://localhost:1234.
   * `normaliseInstanceUrl` refuses http because openEQUELLA's sign-in puts the
   * password in the query string; nothing of the sort applies here, and the
   * design depends on a loopback endpoint working. This test fails the moment
   * anyone routes a model base URL through that check.
   */
  it('accepts a plain-http loopback endpoint, which is what every local runtime serves', async () => {
    const { seen, impl } = urlSpy(() => reply('x'));
    await new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' }, impl).complete(
      'p',
    );
    expect(seen[0]).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('sends no Authorization header when there is no key -- the local case', async () => {
    const spy = headerSpy(() => reply('x'));
    await new OpenAiCompatibleProvider(
      { baseUrl: 'http://localhost:11434/v1', model: 'm' },
      spy.impl,
    ).complete('p');
    expect(spy.headers['authorization']).toBeUndefined();
  });

  it('sends a bearer token when there is a key', async () => {
    const spy = headerSpy(() => reply('x'));
    await new OpenAiCompatibleProvider(
      { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-secret' },
      spy.impl,
    ).complete('p');
    expect(spy.headers['authorization']).toBe('Bearer sk-secret');
  });

  /** A fetch double that records the JSON body it was given. */
  function bodySpy() {
    let body: Record<string, unknown> = {};
    const impl = vi.fn(async (_i: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return reply('x');
    }) as unknown as typeof fetch;
    return {
      get body() {
        return body;
      },
      impl,
    };
  }

  /**
   * TEMPERATURE ZERO IS NOT A DETAIL. prompt.ts spends its opening docblock on
   * invention being the failure this design exists to prevent, and the request
   * used to ship with the backend's own default -- 1.0 at OpenAI, 0.8 at
   * Ollama, which is the setting most likely to produce it. `max_tokens` stops
   * a model that fails to stop, which would otherwise burn the whole time limit
   * generating text nobody reads.
   */
  it('sends the model, the prompt and sampling settled against invention', async () => {
    const spy = bodySpy();
    await new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'llama3' }, spy.impl).complete(
      'the prompt',
    );
    expect(spy.body).toEqual({
      model: 'llama3',
      messages: [{ role: 'user', content: 'the prompt' }],
      temperature: 0,
      max_tokens: 500,
    });
  });

  /**
   * OMITTABLE, NOT MERELY CONFIGURABLE. Reasoning models of the o1/o3 class
   * reject any temperature but their own, and some gateways reject parameters
   * they do not recognise -- so a hardcoded value would make this provider
   * unusable against real endpoints.
   */
  it('sends no temperature at all when configured null', async () => {
    const spy = bodySpy();
    await new OpenAiCompatibleProvider(
      { baseUrl: 'http://x/v1', model: 'm', temperature: null },
      spy.impl,
    ).complete('p');
    expect('temperature' in spy.body).toBe(false);
    // null means OMIT, not "send null" -- a backend rejects the second.
    expect(spy.body['max_tokens']).toBe(500);
  });

  it('sends no max_tokens at all when configured null', async () => {
    const spy = bodySpy();
    await new OpenAiCompatibleProvider(
      { baseUrl: 'http://x/v1', model: 'm', maxTokens: null },
      spy.impl,
    ).complete('p');
    expect('max_tokens' in spy.body).toBe(false);
  });

  it('honours a temperature and a token ceiling the operator chose', async () => {
    const spy = bodySpy();
    await new OpenAiCompatibleProvider(
      { baseUrl: 'http://x/v1', model: 'm', temperature: 0.3, maxTokens: 64 },
      spy.impl,
    ).complete('p');
    expect(spy.body['temperature']).toBe(0.3);
    expect(spy.body['max_tokens']).toBe(64);
  });

  it('returns the message content', async () => {
    const impl = vi.fn(async () => reply('  A description.  ')) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl);
    await expect(p.complete('p')).resolves.toBe('A description.');
  });

  /** Every failure is the same to the caller: no value, and a reason to show. */
  it('reports a non-2xx as a failure rather than as content', async () => {
    const impl = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl);
    await expect(p.complete('p')).rejects.toThrow(/429/);
  });

  it('reports an unparseable body as a failure rather than as content', async () => {
    const impl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p'),
    ).rejects.toThrow();
  });

  it('reports a 200 with no choices as a failure rather than as an empty description', async () => {
    const impl = vi.fn(
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p'),
    ).rejects.toThrow();
  });

  it('reports a 200 whose content is only whitespace as a failure', async () => {
    const impl = vi.fn(async () => reply('   \n  ')) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p'),
    ).rejects.toThrow(/no text/i);
  });
});

/**
 * Configuration is refused at construction, in words about the setting.
 *
 * Not at the first row, and never as a raw `TypeError`. `fill.ts` catches
 * `ApiError` and writes its message onto the row, so anything else escaping
 * from here reaches the operator as "Invalid URL" or "did not answer within 0
 * milliseconds" -- both of which point at the model rather than at the box they
 * mistyped.
 */
describe('what the constructor refuses', () => {
  const ok = vi.fn(async () => reply('x')) as unknown as typeof fetch;

  /**
   * THE ONE COMBINATION THAT LOSES A CREDENTIAL. The docblock used to argue
   * from loopback while the code checked nothing, so a bearer key went to a
   * remote host over plain http with no error and no warning.
   */
  it('refuses to send a key over plain http to a remote host', () => {
    expect(
      () =>
        new OpenAiCompatibleProvider(
          { baseUrl: 'http://models.example.edu/v1', model: 'm', apiKey: 'sk-secret' },
          ok,
        ),
    ).toThrow(/not encrypted|clear text/i);
  });

  it('refuses a key over plain http to a private LAN address, which is not this machine', () => {
    expect(
      () =>
        new OpenAiCompatibleProvider(
          { baseUrl: 'http://192.168.1.10:11434/v1', model: 'm', apiKey: 'sk-secret' },
          ok,
        ),
    ).toThrow(/not encrypted|clear text/i);
  });

  /** The three shapes that must stay free. Refusing any of them would break the
   *  local half of the design, or a site the operator has already judged. */
  it('permits plain http to loopback, https anywhere, and keyless remote http', () => {
    expect(
      () =>
        new OpenAiCompatibleProvider(
          { baseUrl: 'http://localhost:11434/v1', model: 'm', apiKey: 'sk-secret' },
          ok,
        ),
    ).not.toThrow();
    expect(
      () =>
        new OpenAiCompatibleProvider(
          { baseUrl: 'https://models.example.edu/v1', model: 'm', apiKey: 'sk-secret' },
          ok,
        ),
    ).not.toThrow();
    expect(
      () => new OpenAiCompatibleProvider({ baseUrl: 'http://models.example.edu/v1', model: 'm' }, ok),
    ).not.toThrow();
  });

  it('says so in words about the setting when the address will not parse', () => {
    expect(() => new OpenAiCompatibleProvider({ baseUrl: 'not a url', model: 'm' }, ok)).toThrow(
      /not a usable model address/i,
    );
    // And as an ApiError, not the raw `TypeError: Invalid URL` the URL
    // constructor throws.
    expect(() => new OpenAiCompatibleProvider({ baseUrl: '', model: 'm' }, ok)).toThrow(ApiError);
  });

  /**
   * `AbortSignal.timeout` validates its own argument and throws RangeError or
   * TypeError. Zero is worse than either: accepted, and then every call in the
   * batch fails with "did not answer within 0 milliseconds".
   */
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['not a number', Number.NaN],
    ['beyond setTimeout', 1e12],
    ['a string from a settings box', '30s' as unknown as number],
  ])('refuses a time limit that is %s', (_label, timeoutMs) => {
    expect(
      () => new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', timeoutMs }, ok),
    ).toThrow(/time limit/i);
  });

  it('accepts a time limit an operator would plausibly set', () => {
    expect(
      () =>
        new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', timeoutMs: 300_000 }, ok),
    ).not.toThrow();
  });
});

/**
 * A malformed answer is an ApiError, whatever shape it takes.
 *
 * `JSON.parse('null')` followed by `parsed.choices?.[0]` throws `TypeError:
 * Cannot read properties of null` from OUTSIDE every catch block -- unredacted,
 * not an ApiError, and unreadable to the operator whose row it lands on. A
 * proxy answering `null` is not exotic.
 */
describe('every malformed answer', () => {
  it.each([
    ['null', 'null'],
    ['a number', '123'],
    ['a bare string', '"hello"'],
    ['an array', '[1,2]'],
    ['choices null', '{"choices":null}'],
    ['choices empty', '{"choices":[]}'],
    ['a choice with no message', '{"choices":[{}]}'],
    ['a null choice', '{"choices":[null]}'],
    ['a null message', '{"choices":[{"message":null}]}'],
    ['content a number', '{"choices":[{"message":{"content":42}}]}'],
    ['content null', '{"choices":[{"message":{"content":null}}]}'],
    ['content an array', '{"choices":[{"message":{"content":["a"]}}]}'],
    ['an empty object', '{}'],
  ])('reports %s as an ApiError rather than escaping raw', async (_label, payload) => {
    const impl = vi.fn(async () => new Response(payload, { status: 200 })) as unknown as typeof fetch;
    const error = await new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl)
      .complete('p')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toMatch(/no text/i);
  });
});

/**
 * The network reason is preserved, not thrown away.
 *
 * `catch { throw new Error('Could not reach ...') }` is the same message for a
 * DNS failure, a refused connection and a TLS error -- three different problems
 * with three different fixes, and the operator is told none of them. The note
 * that reaches their spreadsheet is all they get, so it has to carry the reason.
 */
describe('what went wrong on the wire survives', () => {
  const throwing = (error: unknown) =>
    vi.fn(async () => {
      throw error;
    }) as unknown as typeof fetch;

  it('names a refused connection as a refused connection', async () => {
    const p = new OpenAiCompatibleProvider(
      { baseUrl: 'http://localhost:11434/v1', model: 'm' },
      throwing(new Error('connect ECONNREFUSED 127.0.0.1:11434')),
    );
    await expect(p.complete('x')).rejects.toThrow(/ECONNREFUSED/);
  });

  /**
   * Node's own fetch throws `TypeError: fetch failed` and puts the real reason
   * on `cause`. Reading only `message` therefore preserves nothing at all --
   * which is how a preserved reason can still be useless.
   */
  it('reads through the cause chain, which is where Node hides the real reason', async () => {
    const outer = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND models.example.edu'),
    });
    const p = new OpenAiCompatibleProvider(
      { baseUrl: 'https://models.example.edu/v1', model: 'm' },
      throwing(outer),
    );
    const error = await p.complete('x').catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/ENOTFOUND/);
  });

  it('still names the endpoint, so the operator knows which address failed', async () => {
    const p = new OpenAiCompatibleProvider(
      { baseUrl: 'https://models.example.edu/gateway/v1', model: 'm' },
      throwing(new Error('socket hang up')),
    );
    await expect(p.complete('x')).rejects.toThrow(/models\.example\.edu\/gateway\/v1\/chat\/completions/);
  });

  /** A gateway client can wrap Node's wrapper. The bound is four, so four
   *  levels must arrive -- otherwise the constant is whatever anyone types. */
  it('reads four levels deep, which is what the bound says', async () => {
    const chain = new Error('outermost', {
      cause: new Error('second', { cause: new Error('third', { cause: new Error('fourth') }) }),
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, throwing(chain));
    const error = await p.complete('x').catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/outermost: second: third: fourth/);
  });

  /** And stops there. Nothing five levels down diagnoses anything, and the
   *  bound is what stops a cyclic chain spinning. */
  it('stops at four, so the bound is a bound', async () => {
    const chain = new Error('one', {
      cause: new Error('two', {
        cause: new Error('three', { cause: new Error('four', { cause: new Error('five') }) }),
      }),
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, throwing(chain));
    const error = await p.complete('x').catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/four/);
    expect((error as Error).message).not.toMatch(/five/);
  });

  it('survives a cause chain that points back at itself', async () => {
    const outer = new Error('outer');
    const inner = new Error('inner', { cause: outer });
    (outer as { cause?: unknown }).cause = inner;
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, throwing(outer));
    await expect(p.complete('x')).rejects.toThrow(/outer: inner/);
  });

  /**
   * `new Error(cause.message, { cause })` is a real and common wrapper. Without
   * the dedup its message is printed twice, in a note an operator has to read.
   */
  it('does not print a wrapper that merely repeats its cause', async () => {
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    const p = new OpenAiCompatibleProvider(
      { baseUrl: 'http://localhost:11434/v1', model: 'm' },
      throwing(new Error(inner.message, { cause: inner })),
    );
    const error = await p.complete('x').catch((e: unknown) => e);
    expect((error as Error).message.match(/ECONNREFUSED/g)).toHaveLength(1);
  });

  /**
   * A wrapper that CONTAINS its cause keeps both, deliberately. Deciding which
   * of two overlapping strings to discard is how a reader loses the half that
   * mattered.
   */
  it('keeps a wrapper that merely contains its cause', async () => {
    const inner = new Error('connect ECONNREFUSED');
    const p = new OpenAiCompatibleProvider(
      { baseUrl: 'http://localhost:11434/v1', model: 'm' },
      throwing(new Error('fetch failed: connect ECONNREFUSED', { cause: inner })),
    );
    await expect(p.complete('x')).rejects.toThrow(/fetch failed: connect ECONNREFUSED: connect/);
  });

  /** A runtime that dumps a stack into its message must not paste it into a
   *  spreadsheet cell. */
  it('cuts a runaway reason short', async () => {
    const p = new OpenAiCompatibleProvider(
      { baseUrl: 'http://x/v1', model: 'm' },
      throwing(new Error('R'.repeat(5000))),
    );
    const error = await p.complete('x').catch((e: unknown) => e);
    expect((error as Error).message.match(/R+/)?.[0].length).toBeLessThanOrEqual(200);
  });
});

/** The same cap, on the other side: a hostile or confused server must not get a
 *  document-sized string into a note either. */
describe('a quoted response body is bounded', () => {
  it('cuts a runaway non-2xx body short', async () => {
    const impl = vi.fn(
      async () => new Response('B'.repeat(5000), { status: 500 }),
    ) as unknown as typeof fetch;
    const error = await new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl)
      .complete('p')
      .catch((e: unknown) => e);
    expect((error as Error).message.match(/B+/)?.[0].length).toBeLessThanOrEqual(200);
  });

  it('cuts a runaway non-JSON body short', async () => {
    const impl = vi.fn(
      async () => new Response('B'.repeat(5000), { status: 200 }),
    ) as unknown as typeof fetch;
    const error = await new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl)
      .complete('p')
      .catch((e: unknown) => e);
    expect((error as Error).message.match(/B+/)?.[0].length).toBeLessThanOrEqual(200);
  });
});

/**
 * A call that hangs is not a call that failed, and must not read like one.
 *
 * This runs once per row across a batch of hundreds. Without a limit, one
 * request that never answers stalls the whole run with nothing on any screen to
 * say why -- and "the model is slow" sends the operator somewhere completely
 * different from "the address is wrong".
 */
describe('the time limit', () => {
  const hangs = vi.fn(
    async () =>
      new Promise<Response>(() => {
        /* never settles -- an overloaded local runtime that accepted the
         * connection and then stopped answering. */
      }),
  ) as unknown as typeof fetch;

  it(
    'gives up rather than hanging for ever',
    async () => {
      const p = new OpenAiCompatibleProvider(
        { baseUrl: 'http://localhost:11434/v1', model: 'm', timeoutMs: 20 },
        hangs,
      );
      await expect(p.complete('x')).rejects.toThrow();
    },
    3000,
  );

  /**
   * DISTINCT FROM UNREACHABLE, on purpose. A timeout means the model answered
   * the connection and then did not finish; the fix is a longer limit or a
   * smaller model. "Check the address" would send the operator to the one place
   * the problem is not.
   */
  it(
    'says it timed out, and does not say the address might be wrong',
    async () => {
      const p = new OpenAiCompatibleProvider(
        { baseUrl: 'http://localhost:11434/v1', model: 'm', timeoutMs: 20 },
        hangs,
      );
      const error = await p.complete('x').catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/did not answer within/i);
      expect((error as Error).message).not.toMatch(/could not reach/i);
    },
    3000,
  );

  it(
    'names the limit that was reached, so the operator knows what to raise',
    async () => {
      const p = new OpenAiCompatibleProvider(
        { baseUrl: 'http://localhost:11434/v1', model: 'm', timeoutMs: 20 },
        hangs,
      );
      await expect(p.complete('x')).rejects.toThrow(/20 ?ms|0\.02 seconds|20 milliseconds/i);
    },
    3000,
  );

  /**
   * The race settles this process's promise; the SIGNAL is what stops the real
   * request and frees the socket. A fetch double ignores it, so nothing else in
   * this file would notice its absence.
   */
  it('hands fetch an abort signal, so a real request is actually cancelled', async () => {
    let signal: AbortSignal | null | undefined;
    const impl = vi.fn(async (_i: string | URL, init?: RequestInit) => {
      signal = init?.signal;
      return reply('x');
    }) as unknown as typeof fetch;
    await new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * A LOCAL MODEL IS NOT A FAST ONE. A 7B on CPU spends tens of seconds reading
   * the prompt and tens more generating, and abandoning it at the usual
   * thirty-second web default would fail every local configuration this feature
   * exists to serve -- while looking exactly like a broken endpoint.
   */
  it('defaults to a limit generous enough for a local model on CPU', () => {
    expect(MODEL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

/**
 * The key never escapes.
 *
 * Modelled on `tests/passwordAuth.test.ts`'s walker and for the same reason: a
 * debug line added later leaks the secret into a file the operator emails
 * around asking for help. Every string reachable from a thrown error is walked,
 * not merely `message`, because this codebase already carries an error class
 * that hangs the server's response off a second field.
 */
describe('the key never escapes', () => {
  /**
   * Deliberately contains `!` and a space, so the three encodings below really
   * are distinct. An all-unreserved key encodes to itself under every encoder
   * and so cannot tell a working redactor from a missing one.
   *
   * The key travels in a HEADER, not a query string, so a server echoing it
   * back echoes the literal. The encoded forms are still checked: a proxy error
   * page or a gateway that folds a header into a URL would percent-encode it,
   * and `redactSecret` already handles all three at no cost.
   */
  const KEY = 'sk-Summer2026!pa ss';

  /**
   * Written out literally rather than computed with the helper the
   * implementation uses -- otherwise a bug in that helper would be mirrored
   * here and the test would agree with the defect instead of catching it.
   */
  const KEY_FORMS = [
    'sk-Summer2026!pa ss', // literal
    'sk-Summer2026!pa%20ss', // encodeURIComponent
    'sk-Summer2026%21pa+ss', // URLSearchParams, i.e. the form a proxy echoes
  ];

  it('has honest fixtures: the three forms really are distinct and correct', () => {
    const url = new URL('https://x/v1');
    url.searchParams.set('key', KEY);
    expect(KEY_FORMS).toEqual([
      KEY,
      encodeURIComponent(KEY),
      url.searchParams.toString().replace('key=', ''),
    ]);
    expect(new Set(KEY_FORMS).size).toBe(3);
  });

  /**
   * The shortest run of the key that still identifies it.
   *
   * A WHOLE-STRING SEARCH CANNOT SEE A TRUNCATION LEAK. Where a message is cut
   * to a length and the boundary lands inside the key, what survives is a
   * PREFIX -- and for a 164-character OpenAI project key that prefix can be 163
   * characters of it. `KEY_FORMS.some(includes)` finds none of that, which is
   * how this file could assert "the key never escapes" while the key was
   * escaping. Every prefix from here up is searched instead, so a straddle is
   * caught wherever the boundary happens to fall.
   *
   * Eight characters, because a redactor that replaces whole forms leaves no
   * prefix at all -- so anything above the length of an accidental collision
   * ("sk-" plus a few) is a real leak.
   */
  const MIN_IDENTIFYING = 8;

  const KEY_FRAGMENTS = KEY_FORMS.flatMap((form) =>
    Array.from({ length: form.length - MIN_IDENTIFYING + 1 }, (_, i) =>
      form.slice(0, MIN_IDENTIFYING + i),
    ),
  );

  const findsKey = (value: unknown): boolean => {
    const seen = new Set<unknown>();
    const walk = (v: unknown): boolean => {
      if (v == null || seen.has(v)) return false;
      seen.add(v);
      if (typeof v === 'string') return KEY_FRAGMENTS.some((form) => v.includes(form));
      if (v instanceof Error) {
        // Own enumerable properties matter as much as the built-ins: ApiError
        // carries the server's response in `body`, and message/stack/cause
        // alone would miss it entirely.
        return (
          walk(v.message) ||
          walk(v.stack) ||
          walk(v.cause) ||
          Object.values(v as unknown as object).some(walk)
        );
      }
      if (typeof v === 'object') return Object.values(v as object).some(walk);
      return false;
    };
    return walk(value);
  };

  const provider = (impl: typeof fetch) =>
    new OpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: KEY, timeoutMs: 20 },
      impl,
    );

  it('is absent from a rejected call, including the echoed body', async () => {
    const impl = vi.fn(
      async (_i: string | URL, init?: RequestInit) =>
        // A gateway echoing the request back, headers and all, is exactly how
        // this leaks.
        new Response(`Rejected: ${new Headers(init?.headers).get('authorization')}`, { status: 401 }),
    ) as unknown as typeof fetch;
    expect(findsKey(await provider(impl).complete('p').catch((e: unknown) => e))).toBe(false);
  });

  /**
   * THE PATH THE PLAN LEFT OPEN. Preserving the network reason is new, and the
   * reason is a string from somewhere this code does not control.
   */
  it('is absent from a preserved network reason, however deep the cause chain', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: new Error(`TLS handshake failed for request with Authorization: Bearer ${KEY}`),
      });
    }) as unknown as typeof fetch;
    expect(findsKey(await provider(impl).complete('p').catch((e: unknown) => e))).toBe(false);
  });

  /**
   * REDACT FIRST, TRUNCATE SECOND -- and this is the test that says so.
   *
   * Every message here is capped so a hostile server cannot paste a document
   * into a spreadsheet note. Truncating BEFORE redacting cuts the key in half
   * and hands the redactor a fragment it cannot match, so a prefix walks
   * straight out. The padding below is sized to land the boundary inside the
   * key deliberately; in the field it lands there by chance, which is worse,
   * because nothing looks wrong.
   */
  describe('even when the cut lands inside it', () => {
    /** Every offset that puts a different part of the key across the boundary.
     *  One padding length would pass by luck. */
    for (const pad of [150, 160, 164, 170, 180, 190, 195, 199]) {
      it(`survives a reason truncated ${pad} characters in`, async () => {
        const impl = vi.fn(async () => {
          throw new TypeError('fetch failed', {
            cause: new Error(`${'x'.repeat(pad)} Bearer ${KEY}`),
          });
        }) as unknown as typeof fetch;
        expect(findsKey(await provider(impl).complete('p').catch((e: unknown) => e))).toBe(false);
      });

      it(`survives a non-2xx body truncated ${pad} characters in`, async () => {
        const impl = vi.fn(
          async () => new Response(`${'x'.repeat(pad)} Bearer ${KEY}`, { status: 401 }),
        ) as unknown as typeof fetch;
        expect(findsKey(await provider(impl).complete('p').catch((e: unknown) => e))).toBe(false);
      });

      it(`survives a non-JSON body truncated ${pad} characters in`, async () => {
        const impl = vi.fn(
          async () => new Response(`${'x'.repeat(pad)} Bearer ${KEY}`, { status: 200 }),
        ) as unknown as typeof fetch;
        expect(findsKey(await provider(impl).complete('p').catch((e: unknown) => e))).toBe(false);
      });
    }
  });

  it('is absent when the body is not JSON', async () => {
    const impl = vi.fn(
      async () => new Response(`<html>bad key ${KEY}</html>`, { status: 200 }),
    ) as unknown as typeof fetch;
    expect(findsKey(await provider(impl).complete('p').catch((e: unknown) => e))).toBe(false);
  });

  it('is absent from a timeout', async () => {
    const impl = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    expect(findsKey(await provider(impl).complete('p').catch((e: unknown) => e))).toBe(false);
  });

  /**
   * WHERE THE OPERATOR PASTED THE KEY INTO THE ADDRESS.
   *
   * Not hypothetical: gateways exist whose published URL carries the key as a
   * path segment, and an operator who has one types it into the address box.
   * Every message naming the endpoint therefore has to be redacted, and without
   * these three the redaction on the timeout branch and on the address-refusal
   * branch is dead code that no test can see -- which is exactly how a
   * "without exception" claim stops being true.
   */
  describe('even when it was pasted into the address', () => {
    const inPath = `https://gw.example.com/proxy/${KEY}/v1`;

    it('is absent from a timeout naming the endpoint', async () => {
      const impl = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
      const p = new OpenAiCompatibleProvider(
        { baseUrl: inPath, model: 'm', apiKey: KEY, timeoutMs: 20 },
        impl,
      );
      expect(findsKey(await p.complete('x').catch((e: unknown) => e))).toBe(false);
    });

    it('is absent from an unreachable endpoint', async () => {
      const impl = vi.fn(async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch;
      const p = new OpenAiCompatibleProvider({ baseUrl: inPath, model: 'm', apiKey: KEY }, impl);
      expect(findsKey(await p.complete('x').catch((e: unknown) => e))).toBe(false);
    });

    it('is absent from the refusal of an address that will not parse', () => {
      const impl = vi.fn(async () => reply('x')) as unknown as typeof fetch;
      let thrown: unknown;
      try {
        new OpenAiCompatibleProvider({ baseUrl: `not a url ${KEY}`, model: 'm', apiKey: KEY }, impl);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect(findsKey(thrown)).toBe(false);
    });
  });

  /**
   * A key belongs in the Authorization header and NOWHERE else. The URL reaches
   * server access logs and proxy logs the header does not.
   */
  it('is absent from the request url', async () => {
    const { seen, impl } = urlSpy(() => reply('x'));
    await new OpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: KEY },
      impl,
    ).complete('p');
    expect(findsKey(seen)).toBe(false);
  });
});

/**
 * The design says "Never a partial value". A reply cut off at the token limit
 * is a well-formed non-empty string, so nothing downstream can tell it from a
 * finished one: it passes `cleanReply` as `ok` and lands in a permanent
 * catalogue record ending mid-sentence, carrying the ordinary "please check
 * this" note and nothing saying it was cut.
 */
describe('a reply the model was cut off in the middle of', () => {
  const truncated = (content: string, finish: string) =>
    new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }),
      { status: 200 },
    );

  it('is a failure, not a value', async () => {
    const impl = vi.fn(async () =>
      truncated('A long description that stops mid-sen', 'length'),
    ) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p'),
    ).rejects.toThrow(ApiError);
  });

  it('says the answer was cut short rather than that the model said nothing', async () => {
    const impl = vi.fn(async () => truncated('Half a sen', 'length')) as unknown as typeof fetch;
    const error = await new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl)
      .complete('p')
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/middle of its answer|token limit/i);
  });

  /** `stop` is the ordinary finished answer and must not be disturbed. */
  it('accepts a reply that finished normally', async () => {
    const impl = vi.fn(async () => truncated('A description.', 'stop')) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p'),
    ).resolves.toBe('A description.');
  });

  /**
   * Several backends omit `finish_reason` entirely -- Ollama's compatibility
   * layer among them. Treating absence as truncation would fail every call
   * against them, which is the opposite of the one wire format this class
   * exists to provide.
   */
  it('does not treat a missing finish_reason as truncation', async () => {
    const impl = vi.fn(async () => reply('A description.')) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p'),
    ).resolves.toBe('A description.');
  });
});

/**
 * The same rule, asked in the unit an operator types.
 *
 * A TRANSLATION, NOT A SECOND RULE. Setup's box says "Seconds to wait for one
 * answer" and the value is multiplied by 1000 before anything checks it, so the
 * refusal came back naming milliseconds and quoting a number nobody had typed.
 * These tests pin that the two answers cannot disagree -- which is the property
 * a second copy of the rule would lose.
 */
describe('timeoutSecondsProblem', () => {
  const ok = vi.fn(async () => reply('x')) as unknown as typeof fetch;

  it.each([
    ['a plain value', 120],
    ['one second', 1],
    ['the largest a timer can hold', MAX_TIMEOUT_SECONDS],
  ])('accepts %s', (_label, seconds) => {
    expect(timeoutSecondsProblem(seconds)).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['a negative value', -5],
    ['a blank box, which arrives as NaN', Number.NaN],
    ['more than a timer can hold', MAX_TIMEOUT_SECONDS + 1],
  ])('refuses %s', (_label, seconds) => {
    expect(timeoutSecondsProblem(seconds)).not.toBeNull();
  });

  /** The whole point: the operator reads back the unit they were asked for. */
  it('says seconds, and never milliseconds', () => {
    const message = timeoutSecondsProblem(5_000_000)!;
    expect(message).toMatch(/seconds/);
    expect(message).not.toMatch(/millisecond/i);
    expect(message).toContain(String(MAX_TIMEOUT_SECONDS));
  });

  /** It quotes no number back at all, so it cannot quote the converted one --
   *  which is what produced "it was '5000000000'" from a box holding 5000000. */
  it('never quotes a number the operator did not type', () => {
    expect(timeoutSecondsProblem(5_000_000)).not.toContain('5000000000');
    expect(timeoutSecondsProblem(Number.NaN)).not.toContain('NaN');
  });

  /**
   * IT CANNOT DISAGREE WITH THE PROVIDER, because it delegates. Anything this
   * accepts, the constructor accepts; anything it refuses, the constructor
   * refuses. A second copy of the rule is exactly what would break here.
   */
  it.each([1, 120, 3600, MAX_TIMEOUT_SECONDS])('agrees with the provider for %s seconds', (seconds) => {
    const acceptedHere = timeoutSecondsProblem(seconds) === null;
    let acceptedThere = true;
    try {
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm', timeoutMs: seconds * 1000 }, ok);
    } catch {
      acceptedThere = false;
    }
    expect(acceptedHere).toBe(acceptedThere);
  });
});

/**
 * ## Asking an endpoint what it can run
 *
 * REPORTED BY THE OPERATOR: "in the ollama settings I can't tell which ollama
 * model I have". The model name was a free-text box, and a mistyped tag --
 * `llama3.1` where the machine holds `llama3.1:8b` -- fails later, during a
 * batch, as a completion error rather than as a settings mistake.
 *
 * `/models` is part of the OpenAI-compatible contract this provider already
 * targets, so this stays generic: it is not an Ollama feature and must not
 * become one. An endpoint that does not implement it says so and the operator
 * types the name, exactly as before.
 */
describe('OpenAiCompatibleProvider.listModels', () => {
  const list = (ids: string[]) =>
    new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }), { status: 200 });

  it('asks the endpoint for its model list, beside the completions path', async () => {
    const { seen, impl } = urlSpy(() => list(['b', 'a']));
    await new OpenAiCompatibleProvider({ baseUrl: 'https://host/gateway/v1', model: 'm' }, impl).listModels();
    expect(seen).toEqual(['https://host/gateway/v1/models']);
  });

  /** Sorted, so the same endpoint offers the same order every time it is asked
   *  -- a list that reshuffles between clicks reads as a different answer. */
  it('returns the ids, sorted', async () => {
    const { impl } = urlSpy(() => list(['llama3.2:3b', 'deepseek-r1:14b', 'llama3.1:8b']));
    const models = await new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' }, impl).listModels();
    expect(models).toEqual(['deepseek-r1:14b', 'llama3.1:8b', 'llama3.2:3b']);
  });

  /** Reachable, and holding nothing. Not an error: the operator needs to know
   *  the difference between "cannot ask" and "nothing installed". */
  it('returns an empty list for an endpoint with no models', async () => {
    const { impl } = urlSpy(() => list([]));
    const models = await new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' }, impl).listModels();
    expect(models).toEqual([]);
  });

  it('sends the API key when there is one', async () => {
    const spy = headerSpy(() => list(['gpt-4o']));
    await new OpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-secret' },
      spy.impl,
    ).listModels();
    expect(spy.headers['authorization']).toBe('Bearer sk-secret');
  });

  /** Many endpoints implement completions and not listing. That is a fact
   *  about them, not a failure of the settings, and the message says so. */
  it('says the endpoint does not offer a list when it answers 404', async () => {
    const impl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'https://host/v1', model: 'm' }, impl).listModels(),
    ).rejects.toThrow(/does not offer a list of models/i);
  });

  it('reports any other refusal with its status', async () => {
    const impl = (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'https://host/v1', model: 'm' }, impl).listModels(),
    ).rejects.toThrow(/401/);
  });

  it('refuses a reply that is not a model list rather than inventing one', async () => {
    const impl = (async () => new Response('<html>hello</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'https://host/v1', model: 'm' }, impl).listModels(),
    ).rejects.toThrow(/did not answer with a list of models/i);
  });

  /** The same rule the completions path follows: the key is what makes plain
   *  http unacceptable, and only off this machine. */
  it('never sends a key over plain http to another host', async () => {
    const impl = (async () => list(['m'])) as unknown as typeof fetch;
    expect(
      () => new OpenAiCompatibleProvider({ baseUrl: 'http://models.example.com/v1', model: 'm', apiKey: 'sk-x' }, impl),
    ).toThrow(/clear text/i);
  });

  it('does not put the key in the error when the endpoint refuses', async () => {
    const impl = (async () => new Response('denied sk-secret', { status: 401 })) as unknown as typeof fetch;
    const err = (await new OpenAiCompatibleProvider(
      { baseUrl: 'https://host/v1', model: 'm', apiKey: 'sk-secret' },
      impl,
    ).listModels().catch((e: unknown) => e)) as Error;
    expect(JSON.stringify({ m: err.message, s: (err as ApiError).body })).not.toContain('sk-secret');
  });
});
