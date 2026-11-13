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

/** One folder row as the desktop's Review screen shows it. */
export interface FolderSummary {
  rowNumber: number;
  /** `rowLabel`: the folder name and its file count. */
  label: string;
  /** In upload order. */
  files: string[];
  skipped: { name: string; reason: string }[];
}

/**
 * The same account as `folderLines`, as data, for the desktop -- which
 * renders it as markup rather than printing lines. One source for both, so
 * the two surfaces cannot list a folder differently.
 */
export function planFolders(entries: readonly ManifestEntry[]): FolderSummary[] {
  return entries
    .filter((e) => e.folderPath !== undefined)
    .map((e) => ({
      rowNumber: e.rowNumber,
      label: rowLabel(e),
      files: e.files.map((f) => f.name),
      skipped: e.skippedFiles ?? [],
    }));
}
