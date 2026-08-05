// src/core/extract/pattern.ts
import { ValidationError } from '../errors.js';

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** The placeholder names in a pattern, in order. Throws if one is repeated. */
export function placeholders(pattern: string): string[] {
  const names = [...pattern.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      // Wording matches sheet.ts's "Duplicate column headers" -- same problem,
      // same word, so the two errors read as one family.
      throw new ValidationError(`Duplicate placeholder {${n}}: each name may appear only once in a pattern.`);
    }
    seen.add(n);
  }
  return names;
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a pattern to an anchored, case-insensitive regex.
 *
 * Every placeholder becomes a lazy `(.+?)`. Lazy is deliberate: leftmost
 * placeholders take as little as possible, so any unexpected extra separator
 * lands in the final placeholder rather than silently shifting every field
 * along by one. One predictable rule beats a clever one nobody can predict.
 */
function compile(pattern: string): RegExp {
  let source = '^';
  let lastIndex = 0;
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    source += escapeLiteral(pattern.slice(lastIndex, match.index));
    source += '(.+?)';
    lastIndex = match.index + match[0].length;
  }
  source += escapeLiteral(pattern.slice(lastIndex));
  source += '$';
  return new RegExp(source, 'i');
}

/**
 * Apply `pattern` to `filename`. Returns a map of placeholder name to captured
 * text, or null if the filename does not match the pattern at all.
 */
export function applyPattern(pattern: string, filename: string): Record<string, string> | null {
  const names = placeholders(pattern);
  const match = compile(pattern).exec(filename);
  if (!match) return null;

  const result: Record<string, string> = {};
  names.forEach((name, i) => {
    result[name] = match[i + 1] ?? '';
  });
  return result;
}
