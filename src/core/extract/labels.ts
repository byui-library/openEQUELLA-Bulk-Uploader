// src/core/extract/labels.ts

/**
 * A label is 1-3 words of letters, up to 40 characters. That upper bound is
 * what stops an ordinary sentence containing a colon from being read as a
 * label -- "Please note that the following applies to all students:" is not a
 * field name, and treating it as one would invent metadata out of prose.
 */
const LABEL_LINE = /^\s*([A-Za-z][A-Za-z ]{0,39}?)\s*:\s*(\S.*?)\s*$/;
const MAX_LABEL_WORDS = 3;

/** Find `Label: value` lines. First occurrence of each label wins. */
export function findLabels(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = LABEL_LINE.exec(line);
    if (!match) continue;
    const label = match[1]!;
    const value = match[2]!;
    if (label.trim().split(/\s+/).length > MAX_LABEL_WORDS) continue;
    if (!found.has(label)) found.set(label, value);
  }
  return found;
}
