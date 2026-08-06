// src/core/duplicates.ts

import type { Manifest } from './types.js';

/**
 * One item already in the collection, as the rules below need to see it.
 *
 * Declared here rather than imported from the API client on purpose: what
 * counts as a duplicate is a rule, and a rule should not depend on the shape
 * of an HTTP response. The client's own `SearchHit` is structurally
 * compatible, so it can be passed straight in.
 */
export interface ExistingItemHit {
  uuid: string;
  version: number;
  name: string;
  attachmentNames: string[];
}

/**
 * How sure the tool is that a row has already been uploaded.
 *
 * Two tiers rather than a yes/no, because they deserve different defaults:
 * a filename match is near-proof, a title match alone is ordinary and often
 * innocent.
 */
export type DuplicateTier = 'near-certain' | 'possible' | 'not-checkable' | 'could-not-check';

export type DuplicateChoice = 'skip' | 'upload';

export interface DuplicateFinding {
  rowNumber: number;
  fileName: string;
  tier: DuplicateTier;
  /** Plain-language reason, shown to the operator as-is. */
  detail: string;
  /** The items already in the collection that caused this. */
  existing: { uuid: string; version: number; title: string; attachmentNames: string[] }[];
}

/** Compare filenames the way the spreadsheet reader already compares attachment names. */
function sameFile(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The verdict for one row, or null if there is nothing to say.
 *
 * `rowNumber` is left at 0 for the caller to fill in: this function is given
 * one row's facts, not the row itself, which is what keeps it testable
 * without a manifest.
 */
export function verdictFor(
  fileName: string,
  title: string,
  hits: readonly ExistingItemHit[],
): DuplicateFinding | null {
  if (title.trim() === '') {
    return {
      rowNumber: 0,
      fileName,
      existing: [],
      tier: 'not-checkable',
      detail: 'this row has no title, so it could not be checked for duplicates',
    };
  }

  if (hits.length === 0) return null;

  const existing = hits.map((h) => ({
    uuid: h.uuid,
    version: h.version,
    title: h.name,
    attachmentNames: h.attachmentNames,
  }));

  const holdsThisFile = hits.some((h) => h.attachmentNames.some((n) => sameFile(n, fileName)));

  return holdsThisFile
    ? {
        rowNumber: 0,
        fileName,
        existing,
        tier: 'near-certain',
        detail: `an item with this title already holds a file called '${fileName}'`,
      }
    : {
        rowNumber: 0,
        fileName,
        existing,
        tier: 'possible',
        detail: 'an item with this title already exists, but holds a different file',
      };
}

/**
 * What happens to a flagged row if the operator changes nothing.
 *
 * Only a near-certain match defaults to skipping. Everything else uploads,
 * because a silent omission is worse than a visible duplicate -- a duplicate
 * can be seen and deleted; an item that never arrived cannot be noticed.
 */
export function defaultChoice(tier: DuplicateTier): DuplicateChoice {
  return tier === 'near-certain' ? 'skip' : 'upload';
}

/**
 * Just the part of the API client this needs.
 *
 * Narrower than the client class on purpose: the rules above are testable
 * without a server, and so is this.
 */
export interface TitleSearcher {
  searchByTitle(collectionUuid: string, title: string): Promise<ExistingItemHit[]>;
}

/** How many checks are in flight at once. Enough to be quick, few enough to be polite. */
const CONCURRENCY = 5;

/**
 * Check every pending row against the collection.
 *
 * A failure for one row becomes its own `could-not-check` finding rather than
 * aborting the batch: an unreachable server says nothing about whether a title
 * exists, and it must not block a plan that is otherwise ready. It must
 * equally never be reported as clean, which is why it produces a finding at
 * all rather than being swallowed.
 */
export async function findDuplicates(
  client: TitleSearcher,
  manifest: Manifest,
): Promise<DuplicateFinding[]> {
  const pending = manifest.entries.filter((e) => e.status === 'pending');
  const findings: DuplicateFinding[] = [];

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const results = await Promise.all(
      pending.slice(i, i + CONCURRENCY).map(async (entry) => {
        const title = entry.metadata['MWDL/title']?.[0] ?? '';
        try {
          const hits =
            title.trim() === '' ? [] : await client.searchByTitle(manifest.collectionUuid, title);
          const verdict = verdictFor(entry.fileName, title, hits);
          return verdict ? { ...verdict, rowNumber: entry.rowNumber } : null;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return {
            rowNumber: entry.rowNumber,
            fileName: entry.fileName,
            tier: 'could-not-check' as const,
            detail: `could not check whether this already exists (${detail})`,
            existing: [],
          };
        }
      }),
    );
    for (const r of results) if (r) findings.push(r);
  }

  return findings;
}
