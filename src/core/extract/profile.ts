// src/core/extract/profile.ts
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { suggest } from '../schema.js';
import { placeholders } from './pattern.js';
import { ATTACHMENT_COLUMN, type DocumentProperty, type Profile } from './types.js';

const PROPERTY_NAMES = ['title', 'author', 'subject', 'keywords', 'created'] as const;

/**
 * Fails to compile if PROPERTY_NAMES drifts from the DocumentProperty union in
 * types.ts -- add a property there and forget this file, and the build stops.
 */
const _propertiesAreExhaustive: DocumentProperty extends (typeof PROPERTY_NAMES)[number] ? true : never = true;
void _propertiesAreExhaustive;

const sourceSchema = z.union([
  z.object({ placeholder: z.string().min(1) }).strict(),
  z.object({ join: z.string().min(1) }).strict(),
  z.object({ label: z.string().min(1) }).strict(),
  z.object({ tableColumn: z.string().min(1) }).strict(),
  z.object({ property: z.enum(PROPERTY_NAMES) }).strict(),
  z.object({ filename: z.literal(true) }).strict(),
]);

const columnSchema = z
  .object({
    path: z.string().min(1),
    sources: z.array(sourceSchema),
    default: z.string().optional(),
    transform: z
      .union([z.literal('date'), z.object({ date: z.string().min(1) }).strict()])
      .optional(),
    locked: z.boolean().optional(),
  })
  .strict();

const profileSchema = z
  .object({
    version: z.literal(1),
    pattern: z.string().min(1),
    columns: z.array(columnSchema).min(1),
  })
  .strict();


/** Every `{name}` used inside a join template. */
function joinPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
}

/**
 * Parse and fully validate a profile. Everything that can be checked without
 * touching the schema file or the filesystem is checked here, so a bad profile
 * fails at load time rather than after three hundred files.
 */
export function parseProfile(input: unknown): Profile {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Profile is not valid:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const profile = parsed.data as Profile;

  const paths = profile.columns.map((c) => c.path);
  const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
  if (duplicates.length > 0) {
    throw new ValidationError(`Duplicate column paths: ${[...new Set(duplicates)].join(', ')}`);
  }

  if (paths[0] !== ATTACHMENT_COLUMN) {
    const message = paths.includes(ATTACHMENT_COLUMN)
      ? `'${ATTACHMENT_COLUMN}' must be the first column.`
      : `Profile must include the '${ATTACHMENT_COLUMN}' column -- it is how each row is matched to its file.`;
    throw new ValidationError(message);
  }

  // A declared date format must name each part exactly once. Catching this at
  // load time matters: a malformed format compiles to a regex that simply
  // never matches, so every row would be silently kept-as-found and flagged,
  // with nothing pointing at the profile as the cause.
  for (const column of profile.columns) {
    if (column.transform === undefined || column.transform === 'date') continue;
    const format = column.transform.date;
    for (const token of ['YYYY', 'MM', 'DD'] as const) {
      const occurrences = format.split(token).length - 1;
      if (occurrences !== 1) {
        throw new ValidationError(
          `Column '${column.path}' has date format '${format}', which uses ${token} ${occurrences} times. ` +
            `A format must use YYYY, MM and DD exactly once each, e.g. 'MMDDYYYY' or 'DD-MM-YYYY'.`,
        );
      }
    }
  }

  const known = new Set(placeholders(profile.pattern));
  for (const column of profile.columns) {
    for (const source of column.sources) {
      const used =
        'placeholder' in source ? [source.placeholder]
        : 'join' in source ? joinPlaceholders(source.join)
        : [];
      for (const name of used) {
        if (!known.has(name)) {
          throw new ValidationError(
            `Column '${column.path}' uses {${name}}, which the pattern '${profile.pattern}' does not define.`,
          );
        }
      }
    }
  }

  return profile;
}

export interface SchemaProblem {
  path: string;
  suggestions: string[];
}

/**
 * Check every column path against the real schema. Returns problems rather
 * than throwing, so a caller can show all of them at once instead of one per
 * run.
 */
export function validateAgainstSchema(profile: Profile, schemaPaths: Set<string>): SchemaProblem[] {
  return profile.columns
    .filter((c) => c.path !== ATTACHMENT_COLUMN && !schemaPaths.has(c.path))
    .map((c) => ({ path: c.path, suggestions: suggest(c.path, schemaPaths) }));
}

export async function loadProfile(path: string): Promise<Profile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw new ValidationError(`Could not read profile '${path}'.`, { cause });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new ValidationError(`Profile '${path}' is not valid JSON.`, { cause });
  }

  try {
    return parseProfile(json);
  } catch (error) {
    throw new ValidationError(`Profile '${path}' is not valid: ${(error as Error).message}`, { cause: error });
  }
}

/** Write a profile as indented JSON -- it is meant to be opened and edited by hand. */
export async function saveProfile(path: string, profile: Profile): Promise<void> {
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
}
