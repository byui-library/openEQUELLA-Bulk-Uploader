// src/core/seriesIndex/files.ts
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INDEX_FILE_NAMES, type IndexFiles } from './types.js';

/**
 * The web-server copy: the three files in a chosen folder. NEVER replaces a
 * file of the same name without `replace` -- the folder may be a live site's
 * -- and never touches any other file there.
 */
export type SaveFilesResult = { kind: 'saved'; paths: string[] } | { kind: 'exists'; names: string[] };

export async function saveIndexFiles(dir: string, files: IndexFiles, replace: boolean): Promise<SaveFilesResult> {
  if (!replace) {
    const names: string[] = [];
    for (const name of INDEX_FILE_NAMES) {
      try {
        await access(join(dir, name));
        names.push(name);
      } catch {
        // absent: fine
      }
    }
    if (names.length > 0) return { kind: 'exists', names };
  }
  const paths: string[] = [];
  for (const name of INDEX_FILE_NAMES) {
    const path = join(dir, name);
    await writeFile(path, files[name], 'utf8');
    paths.push(path);
  }
  return { kind: 'saved', paths };
}
