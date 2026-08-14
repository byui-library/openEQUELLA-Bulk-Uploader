// src/core/ai/pass.ts
//
// NOT REACHABLE FROM `src/desktop/ui/`, and it does not need to be: this is the
// half that builds a provider and makes requests, which belongs to the main
// process and the CLI. The renderer's only interest was the two default
// numbers, and those live in `defaults.ts`, a leaf that imports nothing.
import type { Profile } from '../extract/types.js';
import { fillWithModel, modelSections, type FillTarget } from './fill.js';
import { OpenAiCompatibleProvider } from './provider.js';

/**
 * A model endpoint as either front end holds it.
 *
 * The desktop's `ModelSettings` (secrets.ts) is this plus storage concerns; the
 * CLI builds one from the environment. Stated structurally rather than by
 * importing the desktop's type, which would point the dependency the wrong way.
 */
export interface ModelPassSettings {
  baseUrl: string;
  model: string;
  /** Empty or absent for a local runtime, which needs no key. */
  apiKey?: string;
  budget: number;
  cap: number;
  /** Milliseconds. Omitted takes `MODEL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Run the model pass over rows that have already been extracted.
 *
 * ## Why this is one function rather than two copies
 *
 * The CLI and the desktop reach this point by completely different routes -- an
 * environment and a `--yes` flag on one side, an encrypted per-instance store
 * and a dialog on the other -- but what happens NEXT must be identical: the same
 * provider, the same budget, the same cap, the same house style, the same
 * sections. Written twice, the two would drift, and the drift would show up as a
 * batch that cost more or read differently depending on which front end an
 * operator happened to use.
 *
 * ## What it does not decide
 *
 * Whether to run at all. That is the caller's, because the two surfaces answer
 * it differently and both answers involve asking a human. A caller with no
 * settings calls `noteMissingModel` instead -- the cell must say it could not be
 * filled, never simply come out blank.
 *
 * `fetchImpl` is injected the whole way down so a test can prove nothing was
 * sent, which is the guard on the zero-prerequisite promise.
 */
export async function runModelPass(
  targets: FillTarget[],
  profile: Profile,
  settings: ModelPassSettings,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const provider = new OpenAiCompatibleProvider(
    {
      baseUrl: settings.baseUrl,
      model: settings.model,
      // An empty string is "no key", not a key of length zero: `provider.ts`
      // reads a falsy value as "send no Authorization header", and a local
      // runtime is the case that has none.
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
    },
    fetchImpl,
  );

  await fillWithModel(targets, profile, provider, {
    budget: settings.budget,
    cap: settings.cap,
    // Both read off the profile rather than passed in, so a template's house
    // style and its section headings reach the model without either front end
    // having to remember to forward them.
    sections: modelSections(profile),
    instruction: profile.aiInstruction ?? null,
    model: settings.model,
  });
}
