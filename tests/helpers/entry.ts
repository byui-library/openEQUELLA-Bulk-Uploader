import type { ManifestEntry } from '../../src/core/types.js';

/**
 * A pending single-file row, manifest v2 shape. No size is recorded, so the
 * run's size check is skipped for it -- exactly as for a row loaded from a v1
 * manifest. Pass `files` in `extra` to give one.
 */
export function fileEntry(
  rowNumber: number,
  path: string,
  name: string,
  extra: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    rowNumber,
    source: name,
    files: [{ path, name }],
    metadata: {},
    status: 'pending',
    attempts: 0,
    ...extra,
  };
}
