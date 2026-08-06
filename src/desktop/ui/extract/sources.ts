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
  if ('placeholder' in source) return `Filename part: ${source.placeholder}`;
  if ('join' in source) return `Filename parts joined as "${source.join}"`;
  if ('label' in source) return `Label in document: ${source.label}`;
  if ('tableColumn' in source) return `Table column: ${source.tableColumn}`;
  if ('section' in source) return `Section: ${source.section}`;
  return `Document property: ${source.property}`;
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
  for (const property of scan.properties) {
    options.push({
      label: `Document property: ${property}`,
      source: { property: property as DocumentProperty },
    });
  }
  return options;
}
