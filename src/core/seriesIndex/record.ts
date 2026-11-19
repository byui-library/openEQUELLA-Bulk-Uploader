// src/core/seriesIndex/record.ts
import { ValidationError } from '../errors.js';
import { resolveIdentifierPath } from '../plan.js';
import type { Profile } from '../extract/types.js';

/**
 * The index item's own catalogue record, from the template's `index`
 * section and the collection's schema. PURE.
 *
 * Title and description are REQUIRED -- the page shows both -- and are read
 * at the paths the schema DECLARES, never at a literal. The identifier is how
 * a rebuild finds the item it is updating; without one the openEQUELLA
 * destination is refused (reported, not thrown) and saving files still works.
 */

export interface IndexSchema {
  titleHeader: string | null;
  descriptionHeader: string | null;
  paths: Set<string>;
}

export interface IndexRecord {
  title: string;
  description: string;
  /** Every column, ready for buildMetadataXml. */
  fields: Record<string, string[]>;
  identifier: { path: string; value: string } | null;
  /** Why the openEQUELLA destination cannot be used; null when it can. */
  identifierProblem: string | null;
}

export function indexRecord(section: NonNullable<Profile['index']>, schema: IndexSchema): IndexRecord {
  const unknown = section.columns.map((c) => c.path).filter((p) => !schema.paths.has(p));
  if (unknown.length > 0) {
    throw new ValidationError(
      `The template's index section names ${unknown.join(', ')}, which this collection's schema does not have.`,
    );
  }
  const value = (path: string) => section.columns.find((c) => c.path === path)?.value;

  if (schema.titleHeader === null) {
    throw new ValidationError("This collection's schema declares no name path, so the index has no title to show.");
  }
  const title = value(schema.titleHeader);
  if (title === undefined) {
    throw new ValidationError(`The template's index section gives no ${schema.titleHeader}, the index's title.`);
  }
  if (schema.descriptionHeader === null) {
    throw new ValidationError("This collection's schema declares no description path, so the index has no description to show.");
  }
  const description = value(schema.descriptionHeader);
  if (description === undefined) {
    throw new ValidationError(
      `The template's index section gives no ${schema.descriptionHeader}, the index's description.`,
    );
  }

  const fields: Record<string, string[]> = {};
  for (const c of section.columns) fields[c.path] = [c.value];

  const identifierPath = resolveIdentifierPath({ titleHeader: schema.titleHeader, paths: schema.paths });
  let identifier: IndexRecord['identifier'] = null;
  let identifierProblem: string | null = null;
  if (identifierPath === null) {
    identifierProblem =
      "This collection's schema has no identifier field, so a rebuild could not find the index item to update. " +
      'Save the page as files instead.';
  } else {
    const id = value(identifierPath);
    if (id === undefined) {
      identifierProblem =
        `The template's index section gives no ${identifierPath}, which is how a rebuild finds the index item ` +
        'to update. Add it to the template, or save the page as files instead.';
    } else {
      identifier = { path: identifierPath, value: id };
    }
  }
  return { title, description, fields, identifier, identifierProblem };
}
