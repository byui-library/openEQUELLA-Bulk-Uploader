import { describe, it, expect, vi } from 'vitest';
import {
  MODEL_TIMEOUT_MS,
  OpenAiCompatibleProvider,
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

  it('sends the model and the prompt as a chat completion', async () => {
    let body: unknown;
    const impl = vi.fn(async (_i: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return reply('x');
    }) as unknown as typeof fetch;
    await new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'llama3' }, impl).complete(
      'the prompt',
    );
    expect(body).toEqual({
      model: 'llama3',
      messages: [{ role: 'user', content: 'the prompt' }],
    });
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

  const findsKey = (value: unknown): boolean => {
    const seen = new Set<unknown>();
    const walk = (v: unknown): boolean => {
      if (v == null || seen.has(v)) return false;
      seen.add(v);
      if (typeof v === 'string') return KEY_FORMS.some((form) => v.includes(form));
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
