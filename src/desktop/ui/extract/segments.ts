// src/desktop/ui/extract/segments.ts
import { applyPattern, placeholders } from '../../../core/extract/pattern.js';

export interface FilenameDescription {
  matched: boolean;
  parts: { name: string; value: string }[];
}

/**
 * Show what a pattern actually does to a real filename, so the operator can
 * see the result rather than reason about the template. A pattern that is
 * itself invalid (a repeated placeholder) reports no match rather than
 * throwing: this runs on every keystroke while the pattern is being edited,
 * and half-typed input is normal, not exceptional.
 */
export function describeFilename(pattern: string, filename: string): FilenameDescription {
  let names: string[];
  try {
    names = placeholders(pattern);
  } catch {
    return { matched: false, parts: [] };
  }

  const captured = applyPattern(pattern, filename);
  if (captured === null) {
    return { matched: false, parts: names.map((name) => ({ name, value: '' })) };
  }
  return { matched: true, parts: names.map((name) => ({ name, value: captured[name] ?? '' })) };
}
