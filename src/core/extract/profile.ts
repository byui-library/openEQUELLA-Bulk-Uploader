// src/core/extract/profile.ts
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { suggest } from '../schema.js';
import { placeholders } from './pattern.js';
import { ATTACHMENT_COLUMN, type DocumentProperty, type Profile, type Source } from './types.js';

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
  z.object({ section: z.string().min(1) }).strict(),
  z.object({ opening: z.literal(true) }).strict(),
  z.object({ filenameStem: z.literal(true) }).strict(),
  z.object({ property: z.enum(PROPERTY_NAMES) }).strict(),
  z.object({ dateNear: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ datePair: z.union([z.literal('first'), z.literal('second')]) }).strict(),
  z.object({ compose: z.string().min(1) }).strict(),
  z.object({
    presence: z.object({ any: z.array(z.string().min(1)).min(1), then: z.string().min(1) }).strict(),
  }).strict(),
  z.object({ filename: z.literal(true) }).strict(),
  z.object({ ai: z.literal(true) }).strict(),
]);

/**
 * Fails to compile if the Source union in types.ts grows a member this loader
 * cannot parse. Without it a source can be type-legal and loader-illegal at
 * once -- which is exactly what happened when `{ ai: true }` was added to the
 * union and this schema was not, leaving a profile the code accepted and
 * `parseProfile` rejected.
 */
const _sourcesAreExhaustive: Source extends z.infer<typeof sourceSchema> ? true : never = true;
void _sourcesAreExhaustive;

const columnSchema = z
  .object({
    path: z.string().min(1),
    sources: z.array(sourceSchema),
    default: z.string().optional(),
    transform: z
      .union([z.literal('date'), z.literal('people'), z.object({ date: z.string().min(1) }).strict()])
      .optional(),
    locked: z.boolean().optional(),
    as: z.string().min(1).optional(),
    flagIfEmpty: z.boolean().optional(),
    composeOnly: z.boolean().optional(),
  })
  .strict();

const profileSchema = z
  .object({
    version: z.literal(1),
    pattern: z.string().min(1),
    columns: z.array(columnSchema).min(1),
    aiProvenance: z
      .object({ path: z.string().min(1), append: z.string().min(1) })
      .strict()
      .optional(),
    aiInstruction: z.string().min(1).optional(),
    checks: z
      .object({
        filenameWordsInText: z.object({ ignore: z.array(z.string()).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();


/** Every `{name}` used inside a join template, by the rule for what a name may
 *  be. What `join` and `compose` accept, and the only thing they substitute. */
function joinPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
}

/**
 * Every `{...}` in a template, whatever is inside it.
 *
 * WIDER THAN `joinPlaceholders` ON PURPOSE, and used only by `checkProvenance`.
 * That function's job is to refuse anything that would be written into a
 * permanent catalogue record verbatim, and the narrow pattern above cannot see
 * most of the ways to get that wrong: it matches `{modle}` but not `{ model }`,
 * `{model-name}` or `{2}`, each of which is a plausible typo and each of which
 * would appear, exactly as typed, on every item in the batch.
 *
 * The narrow rule stays where it is. `join` and `compose` resolve a name against
 * the profile's own aliases and already fail loudly on an unknown one; this is
 * for the single field where a brace has one legal spelling and everything else
 * is a mistake nothing downstream would ever mention.
 */
function anyPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
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

  // Aliases must be unique, or a compose template would silently read
  // whichever column happened to be declared last.
  const aliases = profile.columns.map((c) => c.as).filter((a): a is string => a !== undefined);
  const dupeAlias = aliases.find((a, i) => aliases.indexOf(a) !== i);
  if (dupeAlias !== undefined) {
    throw new ValidationError(`Two columns both use the name '${dupeAlias}'.`);
  }

  // A composeOnly column is never written to the sheet, so a compose template
  // reading it by name is the ONLY way its value can leave the extractor. With
  // no name it is extracted on every row and then silently discarded.
  for (const column of profile.columns) {
    if (column.composeOnly === true && column.as === undefined) {
      throw new ValidationError(
        `Column '${column.path}' is composeOnly but has no "as" name, so nothing could read it. ` +
          `Add "as": "<name>" and compose from '{<name>}', or remove "composeOnly".`,
      );
    }
  }

  // A compose naming a column that does not exist would compose to nothing on
  // every row, silently. Fail here rather than after three hundred files --
  // the same reason a malformed date format is rejected at load.
  const composedAliases = new Set(
    profile.columns.filter((c) => c.sources.some((s) => 'compose' in s)).map((c) => c.as),
  );
  for (const column of profile.columns) {
    for (const source of column.sources) {
      if (!('compose' in source)) continue;

      // Rejected at load rather than handled at runtime: an unbalanced or
      // nested bracket, or a `;` inside a group, produces literal brackets in
      // a permanent catalogue record. `composeValue` splits on `;` before it
      // handles groups, so a `;` inside one splits the group in half.
      let depth = 0;
      for (const ch of source.compose) {
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === ';' && depth > 0) {
          throw new ValidationError(
            `Column '${column.path}' has a ';' inside a [...] group, which would split it.`,
          );
        }
        if (depth < 0 || depth > 1) {
          throw new ValidationError(
            `Column '${column.path}' has mismatched or nested [ ] in its template.`,
          );
        }
      }
      if (depth !== 0) {
        throw new ValidationError(`Column '${column.path}' has an unclosed [ in its template.`);
      }

      for (const name of joinPlaceholders(source.compose)) {
        if (!aliases.includes(name)) {
          throw new ValidationError(
            `Column '${column.path}' composes from '{${name}}', but no column is named '${name}'. ` +
              `Add "as": "${name}" to the column it should read.`,
          );
        }
        if (composedAliases.has(name)) {
          throw new ValidationError(
            `Column '${column.path}' composes from '{${name}}', which is itself composed. ` +
              `Composed columns are filled after all others, so they cannot read each other.`,
          );
        }
      }
    }
  }

  if (paths[0] !== ATTACHMENT_COLUMN) {
    const message = paths.includes(ATTACHMENT_COLUMN)
      ? `'${ATTACHMENT_COLUMN}' must be the first column.`
      : `Profile must include the '${ATTACHMENT_COLUMN}' column -- it is how each row is matched to its file.`;
    throw new ValidationError(message);
  }

  // `attachment name` is how a row is matched to its file on disk. A composed
  // value there would name something that is not a file and break the
  // one-file-one-item relationship the whole tool rests on.
  const attachment = profile.columns.find((c) => c.path === ATTACHMENT_COLUMN);
  if (attachment?.sources.some((s) => 'compose' in s)) {
    throw new ValidationError(`The '${ATTACHMENT_COLUMN}' column cannot be composed from other columns.`);
  }

  // A declared date format must name each part exactly once. Catching this at
  // load time matters: a malformed format compiles to a regex that simply
  // never matches, so every row would be silently kept-as-found and flagged,
  // with nothing pointing at the profile as the cause.
  for (const column of profile.columns) {
    if (column.transform === undefined || typeof column.transform === 'string') continue;
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

  checkProvenance(profile);

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

/**
 * The only placeholder `aiProvenance.append` may use.
 *
 * Exported so the message below can list it without writing the name twice, and
 * so a second one added later has exactly one place to be added.
 */
export const PROVENANCE_PLACEHOLDERS = ['model'] as const;

/**
 * Refuse a provenance setting that could not do what it says.
 *
 * ## Why the path has to be a column, and why this is where it is decided
 *
 * `csv.ts` writes the spreadsheet by walking `profile.columns`. A value written
 * into `row.cells` under any other key is created and then dropped on the
 * floor -- and every row-level assertion about it still passes, because at row
 * level the value genuinely is there. That is the "reported as if it had run"
 * failure this codebase has shipped repeatedly, and this one would be worse
 * than most: the disclosure that a machine wrote a catalogue record is the one
 * output of this feature that a future reader of the catalogue ever sees.
 *
 * The alternative -- teaching `csv.ts` to emit an extra column for it -- was
 * rejected. It produces a column that does not appear in the desktop's column
 * editor or its preview, that nothing validates against the schema, and that
 * the operator therefore cannot see or check before the file is written. That
 * trades one invisible failure for another.
 *
 * ## And it is what satisfies the schema check
 *
 * `validateAgainstSchema` walks `profile.columns`. So a provenance path the
 * institution's schema does not declare is reported by the machinery that
 * already reports every other undeclared path, in the same list, with the same
 * suggestions. `fill.ts` needs no schema of its own and must not acquire one:
 * `src/core/extract/` never touches the network, which is what lets an operator
 * build a spreadsheet without signing in to anything.
 *
 * ## Two columns that exist and still cannot receive it
 *
 * A `composeOnly` column is filtered out of the sheet by `csv.ts` by design, so
 * writing there is the same silent drop wearing a different hat. And
 * ATTACHMENT_COLUMN names the file on disk -- appending to it renames the
 * attachment and breaks the one-file-one-item relationship the whole tool rests
 * on. `eligible.ts` excludes both for the same two reasons.
 *
 * ## The placeholder
 *
 * `{model}` is substituted; anything else in braces is refused. An `append` with
 * no placeholder at all is fine -- "Description written by a language model" is
 * an honest disclosure that happens not to name which one -- but a mistyped
 * `{modle}` is written verbatim into a permanent record with no moderation
 * queue, on every item in the batch, and nothing downstream would ever mention
 * it.
 */
function checkProvenance(profile: Profile): void {
  const provenance = profile.aiProvenance;
  if (provenance === undefined) return;

  if (provenance.path === ATTACHMENT_COLUMN) {
    throw new ValidationError(
      `"aiProvenance" writes to '${ATTACHMENT_COLUMN}', which names the file on disk. ` +
        `Appending to it would rename the attachment. Name a metadata column instead.`,
    );
  }

  const column = profile.columns.find((c) => c.path === provenance.path);
  if (column === undefined) {
    throw new ValidationError(
      `"aiProvenance" writes to '${provenance.path}', but no column has that path, ` +
        `so nothing would ever appear in the spreadsheet. Add it as a column first -- ` +
        `{ "path": "${provenance.path}", "sources": [] } -- or remove "aiProvenance".`,
    );
  }
  if (column.composeOnly === true) {
    throw new ValidationError(
      `"aiProvenance" writes to '${provenance.path}', which is composeOnly and is never ` +
        `written to the spreadsheet, so the note would be discarded. Point it at an ` +
        `ordinary column.`,
    );
  }

  const allowed = new Set<string>(PROVENANCE_PLACEHOLDERS);
  for (const name of anyPlaceholders(provenance.append)) {
    if (!allowed.has(name)) {
      throw new ValidationError(
        `"aiProvenance" uses {${name}}, which is not substituted, so it would be written ` +
          `into every item exactly as it appears. The only placeholder available is ` +
          `${PROVENANCE_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
      );
    }
  }
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
