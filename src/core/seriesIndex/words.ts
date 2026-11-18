// src/core/seriesIndex/words.ts
// Imports nothing: the sandboxed renderer uses it as well as the CLI.

/** "1 volume", "2 volumes" -- a count with the template's own word for it. */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
