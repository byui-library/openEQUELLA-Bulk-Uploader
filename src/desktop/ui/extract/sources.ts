// src/desktop/ui/extract/sources.ts
import { placeholders } from '../../../core/extract/pattern.js';
import type { DocumentProperty, Source } from '../../../core/extract/types.js';

export interface SourceOption {
  label: string;
  source: Source;
}

/**
 * Just the parts of a folder scan this module needs. Narrower than
 * `ExtractScan` on purpose: the screens hold their own scan-shaped props and
 * should not have to carry fields they never read -- such as the starter
 * profile, which exists only so the renderer never imports the Node-dependent
 * module that builds it.
 */
export interface SourceEvidence {
  labels: string[];
  properties: string[];
  tableColumns: string[];
  sections: string[];
}

/** Plain-language name for a source, used in the dropdown and the column list. */
export function describeSource(source: Source): string {
  if ('filename' in source) return 'The file itself';
  if ('filenameStem' in source) return 'The file name, without its extension';
  if ('placeholder' in source) return `Filename part: ${source.placeholder}`;
  if ('join' in source) return `Filename parts joined as "${source.join}"`;
  if ('label' in source) return `Label in document: ${source.label}`;
  if ('tableColumn' in source) return `Table column: ${source.tableColumn}`;
  if ('section' in source) return `Section: ${source.section}`;
  if ('opening' in source) return 'The start of the document (a guess -- always flagged)';
  if ('dateNear' in source) return `A date after: ${source.dateNear.join(', ')}`;
  if ('datePair' in source)
    return source.datePair === 'first' ? 'The first of a pair of dates' : 'The second of a pair of dates';
  if ('compose' in source) return `Built from other columns: ${source.compose}`;
  if ('presence' in source)
    return `"${source.presence.then}" when the document mentions: ${source.presence.any.join(', ')}`;
  if ('ai' in source) return 'A language model, asked after extraction (only where no source was sure)';
  return `Document property: ${source.property}`;
}

/**
 * The options ONE column's dropdown should offer.
 *
 * `sourceOptions` offers what the FILES supply -- placeholders in the pattern,
 * labels and sections actually found -- plus the three that need no evidence.
 * A column can perfectly well be configured with something else: the shipped
 * obituary template uses `join`, `dateNear`, `presence` and `compose`, and not
 * one of them is on that list.
 *
 * REPORTED BY THE OPERATOR, who saw every configured column reading
 * "(nothing -- fill in Excel)". The `<select>` marks an option selected by
 * comparing labels, nothing matched, and so each one fell back to its first
 * entry and described a configured column as empty. That is worse than untidy:
 * a column that reads as unconfigured invites somebody to configure it, and a
 * shipped template's real sources are then one click from being replaced.
 *
 * APPENDED, NEVER INSERTED. The dropdown's value is an index into this list,
 * so anything but appending would change what an index already on screen
 * means. THE RENDERER AND THE CHANGE HANDLER MUST BOTH CALL THIS: two lists
 * built differently would disagree about that index, which is how a click on
 * one source would store another.
 */
export function optionsForColumn(
  pattern: string,
  scan: SourceEvidence,
  sources: Source[],
): SourceOption[] {
  const offered = sourceOptions(pattern, scan);
  const current = sources[0];
  if (current === undefined) return offered;
  const label = describeSource(current);
  if (offered.some((option) => option.label === label)) return offered;
  return [...offered, { label, source: current }];
}

/**
 * What runs after the source the single dropdown shows, in order, or null when
 * there is nothing after it.
 *
 * The columns screen shows one source per column and sets element 0. That is
 * only honest if the row says what element 0 is not: an operator reading
 * "Built from other columns" has no way to tell that a language model runs
 * after it, nor that choosing something else leaves it running.
 *
 * Deliberately names the later sources rather than counting them. "and 1 more"
 * would point at an expansion this screen does not have yet -- stage 2 of the
 * profile-editor design builds it -- and a hint promising a control that does
 * not exist is worse than no hint.
 */
export function restOfChain(sources: Source[]): string | null {
  const rest = sources.slice(1);
  if (rest.length === 0) return null;
  return rest.map((source) => `then: ${describeSource(source)}`).join(', ');
}

/**
 * The sources worth offering for THESE files. Only placeholders the pattern
 * defines, labels actually found while scanning, and properties actually
 * present. Offering everything conceivable would invite mapping a column to
 * something that is always blank.
 */
export function sourceOptions(pattern: string, scan: SourceEvidence): SourceOption[] {
  let names: string[] = [];
  try {
    names = placeholders(pattern);
  } catch {
    // A half-typed pattern is normal while editing; offer no filename parts
    // rather than failing the whole dropdown.
    names = [];
  }

  const options: SourceOption[] = names.map((name) => ({
    label: `Filename part: ${name}`,
    source: { placeholder: name },
  }));

  for (const label of scan.labels) {
    options.push({ label: `Label in document: ${label}`, source: { label } });
  }
  for (const header of scan.tableColumns) {
    options.push({ label: `Table column: ${header}`, source: { tableColumn: header } });
  }
  for (const heading of scan.sections) {
    options.push({ label: `Section: ${heading}`, source: { section: heading } });
  }
  // Always offered: every document that has text has a start. It is the one
  // option that is not evidence-gated, because it is not evidence -- it is the
  // documented last resort, and it says so in its own label.
  options.push({ label: describeSource({ filenameStem: true }), source: { filenameStem: true } });
  options.push({ label: describeSource({ opening: true }), source: { opening: true } });
  // Offered without evidence-gating for the same reason: nothing in a document
  // makes a model more or less available. It was left out when the model was
  // built, on the grounds that a profile declares one rather than a dropdown
  // offering it -- true of shipping a template, false of an operator
  // configuring their own collection, who otherwise has to hand-edit JSON.
  //
  // WHEN a model may write is untouched by this and stays unconfigurable:
  // an empty cell or a flagged one, never a stated value (`core/ai/eligible.ts`).
  options.push({ label: describeSource({ ai: true }), source: { ai: true } });
  for (const property of scan.properties) {
    options.push({
      label: `Document property: ${property}`,
      source: { property: property as DocumentProperty },
    });
  }
  return options;
}
