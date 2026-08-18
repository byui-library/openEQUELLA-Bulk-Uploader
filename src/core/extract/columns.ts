// src/core/extract/columns.ts
import { ValidationError } from '../errors.js';
import { ATTACHMENT_COLUMN, type Column, type Profile, type Source } from './types.js';

function indexOf(profile: Profile, path: string): number {
  const i = profile.columns.findIndex((c) => c.path === path);
  if (i === -1) throw new ValidationError(`Column '${path}' is not in this profile.`);
  return i;
}

/**
 * The attachment column names the file on disk. Without it the spreadsheet
 * cannot be uploaded at all, so it is not merely inconvenient to lose -- every
 * mutating operation refuses it.
 */
function assertEditable(path: string): void {
  if (path === ATTACHMENT_COLUMN) {
    throw new ValidationError(
      `'${ATTACHMENT_COLUMN}' is required and cannot be removed, moved or retargeted. ` +
        `It is how each row is matched to its file.`,
    );
  }
}

function replaceAt(profile: Profile, index: number, column: Column): Profile {
  const columns = [...profile.columns];
  columns[index] = column;
  return { ...profile, columns };
}

/** Append a new, empty column. An empty column is legitimate: somewhere to type in Excel. */
export function addColumn(profile: Profile, path: string): Profile {
  if (profile.columns.some((c) => c.path === path)) {
    throw new ValidationError(`Column '${path}' is already in this profile.`);
  }
  return { ...profile, columns: [...profile.columns, { path, sources: [] }] };
}

export function removeColumn(profile: Profile, path: string): Profile {
  assertEditable(path);
  const i = indexOf(profile, path);
  const next: Profile = { ...profile, columns: profile.columns.filter((_, n) => n !== i) };

  // AN `aiProvenance` POINTING AT THE COLUMN JUST REMOVED IS DROPPED WITH IT.
  //
  // `parseProfile` refuses a provenance path that is not a writable column,
  // because `csv.ts` builds the sheet from `columns` and a value written
  // anywhere else is created and silently discarded. That check runs at LOAD
  // time; this function rewrites the profile in memory and the desktop's
  // `extractRun` never re-parses -- so without this, deleting the column in the
  // editor left a setting the loader would have refused, and the one disclosure
  // that survives an upload would have gone quietly nowhere.
  //
  // Dropped rather than refused: removing a column is an ordinary edit, and
  // blocking it because of a setting elsewhere in the profile would leave the
  // operator no way forward except to hand-edit JSON. `fill.ts#discloseInItem`
  // still checks and reports, because "an earlier step guaranteed it" is the
  // reasoning that was wrong here in the first place.
  if (next.aiProvenance?.path === path) delete next.aiProvenance;
  return next;
}

/**
 * Move a column by `delta` positions. Clamped so nothing can land above the
 * locked attachment column at index 0, or past the end. Clamping rather than
 * throwing keeps a held-down arrow key from erroring at the boundary.
 */
export function moveColumn(profile: Profile, path: string, delta: number): Profile {
  assertEditable(path);
  const from = indexOf(profile, path);
  const to = Math.min(Math.max(from + delta, 1), profile.columns.length - 1);
  if (to === from) return profile;

  const columns = [...profile.columns];
  const [moved] = columns.splice(from, 1);
  columns.splice(to, 0, moved!);
  return { ...profile, columns };
}

export function setSources(profile: Profile, path: string, sources: Source[]): Profile {
  assertEditable(path);
  const i = indexOf(profile, path);
  return replaceAt(profile, i, { ...profile.columns[i]!, sources });
}

/**
 * Replace the FIRST source of a column, leaving the rest of the chain alone.
 * `null` removes the first and leaves the rest.
 *
 * THE ORDER IS THE MEANING -- the first non-empty source wins -- so a control
 * that shows one source governs one position, not the list. The columns screen
 * shows exactly one dropdown per column and used to write back a one-element
 * list, which quietly deleted every later tier: on the shipped Alumni Obituary
 * template, touching the description's dropdown removed `{ ai: true }` and
 * switched the language model off with nothing said anywhere.
 *
 * Until the chain has its own editor, the screen states what it does not
 * govern (`restOfChain` in `desktop/ui/extract/sources.ts`). A control that
 * silently governs part of a value is the failure this project keeps having in
 * different clothes.
 */
export function setFirstSource(profile: Profile, path: string, source: Source | null): Profile {
  assertEditable(path);
  const rest = profile.columns[indexOf(profile, path)]!.sources.slice(1);
  return setSources(profile, path, source === null ? rest : [source, ...rest]);
}

/**
 * Set a column's fallback value. An empty string clears it.
 *
 * COPIED WHOLE, NEVER REBUILT FIELD BY FIELD. This used to list the fields it
 * kept -- `path`, `sources`, `transform`, `locked` -- and so discarded `as`,
 * `flagIfEmpty` and `composeOnly` from any column that carried them. Typing a
 * default into the shipped obituary template's `MWDL/coverage` destroyed its
 * `as: birth_date` alias, after which the description's `compose` template
 * named a column that no longer existed and `parseProfile` would refuse the
 * saved profile. A list of fields to keep is wrong again the day a ninth field
 * is added to `Column`; a copy is not.
 *
 * (The rebuild carried a comment blaming `noUnusedLocals` for it. That
 * compiler option is not enabled in this project and never has been.)
 */
export function setDefault(profile: Profile, path: string, value: string): Profile {
  assertEditable(path);
  const i = indexOf(profile, path);
  const next: Column = { ...profile.columns[i]! };
  if (value === '') delete next.default;
  else next.default = value;
  return replaceAt(profile, i, next);
}
