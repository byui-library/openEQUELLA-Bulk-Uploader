// src/core/extract/templates.ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OeqError } from '../errors.js';
import { parseProfile } from './profile.js';
import type { Profile } from './types.js';

/**
 * Templates shipped with the app: a profile carrying one collection's
 * knowledge, chosen instead of starting from a generic scan.
 *
 * A template is ONLY a profile JSON. That is the whole design -- a code pack
 * per collection would need a developer every time and would be its own thing
 * to test, whereas this is one mechanism, tested once, configured many times.
 * The operator authors a new one by saving a profile from the app.
 */
export interface TemplateSummary {
  id: string;
  label: string;
}

/** Where the shipped templates live, relative to the working directory. */
const DIR = 'templates';

const SUFFIX = '.profile.json';

/** "alumni-obituary" -> "Alumni Obituary" */
function labelFor(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export async function listTemplates(dir = DIR): Promise<TemplateSummary[]> {
  const names = await readdir(dir);
  return names
    .filter((n) => n.endsWith(SUFFIX))
    .map((n) => n.slice(0, -SUFFIX.length))
    .sort()
    .map((id) => ({ id, label: labelFor(id) }));
}

/**
 * Validated on the way in, so a template broken by an edit fails here rather
 * than part-way through a batch -- the same reason profiles are validated when
 * the operator opens one.
 */
export async function loadTemplate(id: string, dir = DIR): Promise<Profile> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new OeqError(`Not a template name: '${id}'.`);
  try {
    return parseProfile(JSON.parse(await readFile(join(dir, id + SUFFIX), 'utf8')));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new OeqError(`Could not load the '${id}' template: ${detail}`);
  }
}
