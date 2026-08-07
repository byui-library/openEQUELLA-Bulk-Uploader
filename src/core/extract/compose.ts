// src/core/extract/compose.ts

/**
 * Build one field's value from other fields.
 *
 * Two rules, and the second is the one that earns its keep:
 *
 * - `[...]` is an OPTIONAL GROUP. If any placeholder inside it is empty, the
 *   whole group goes, punctuation included -- so a missing residence cannot
 *   leave `Died January 9, 2024: `.
 * - A `;`-separated CLAUSE whose placeholders are all empty is dropped
 *   entirely, so the output is never `Died January 9, 2024; ;`.
 *
 * An unknown name is treated as empty rather than printed. A template naming a
 * column that does not exist is rejected when the profile loads (profile.ts),
 * so reaching here with one means the column exists and simply had no value.
 */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function fillGroups(text: string, values: Readonly<Record<string, string>>): string {
  // Optional groups first, so a group dropped whole cannot leave its
  // placeholders behind for the clause rule to see as "present".
  return text.replace(/\[([^\][]*)\]/g, (_, inner: string) => {
    const names = [...inner.matchAll(PLACEHOLDER)].map((m) => m[1]!);
    const anyEmpty = names.some((n) => (values[n] ?? '').trim() === '');
    return anyEmpty ? '' : inner;
  });
}

function fillClause(clause: string, values: Readonly<Record<string, string>>): string {
  const names = [...clause.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  // A clause with no placeholders is literal text and always survives.
  if (names.length > 0 && names.every((n) => (values[n] ?? '').trim() === '')) return '';
  return clause.replace(PLACEHOLDER, (_, name: string) => (values[name] ?? '').trim());
}

export function composeValue(template: string, values: Readonly<Record<string, string>>): string {
  return template
    .split(';')
    .map((clause) => fillClause(fillGroups(clause, values), values))
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .join('; ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
