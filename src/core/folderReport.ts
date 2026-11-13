// src/core/folderReport.ts
import { rowLabel, type ManifestEntry } from './types.js';

/**
 * The plan's account of every folder row: its files in the order they will
 * be attached, and what in the folder will not be.
 *
 * PURE, so the CLI and the MCP server print the same lines. The order is a
 * rule, not a judgement (see folderFiles.ts#orderFiles), and this listing is
 * how the operator checks it before anything is uploaded -- the decision was
 * to fix a wrong order by renaming files, which only works if the order is
 * shown.
 */
export function folderLines(entries: readonly ManifestEntry[]): string[] {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.folderPath === undefined) continue;
    lines.push(`Row ${e.rowNumber}: ${rowLabel(e)}, in upload order:`);
    e.files.forEach((f, i) => lines.push(`    ${i + 1}. ${f.name}`));
    for (const s of e.skippedFiles ?? []) lines.push(`    not uploaded: ${s.name} (${s.reason})`);
  }
  return lines;
}
