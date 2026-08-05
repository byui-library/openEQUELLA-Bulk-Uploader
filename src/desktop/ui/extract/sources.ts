// src/desktop/ui/extract/sources.ts
import { placeholders } from '../../../core/extract/pattern.js';
import type { DocumentProperty, Source } from '../../../core/extract/types.js';
import type { ExtractScan } from '../../ipc.js';

export interface SourceOption {
  label: string;
  source: Source;
}

/** Plain-language name for a source, used in the dropdown and the column list. */
export function describeSource(source: Source): string {
  if ('filename' in source) return 'The file itself';
  if ('placeholder' in source) return `Filename part: ${source.placeholder}`;
  if ('join' in source) return `Filename parts joined as "${source.join}"`;
  if ('label' in source) return `Label in document: ${source.label}`;
  return `Document property: ${source.property}`;
}

/**
 * The sources worth offering for THESE files. Only placeholders the pattern
 * defines, labels actually found while scanning, and properties actually
 * present. Offering everything conceivable would invite mapping a column to
 * something that is always blank.
 */
export function sourceOptions(pattern: string, scan: ExtractScan): SourceOption[] {
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
  for (const property of scan.properties) {
    options.push({
      label: `Document property: ${property}`,
      source: { property: property as DocumentProperty },
    });
  }
  return options;
}
