// src/core/seriesIndex/types.ts
/**
 * The series index: one page listing a serial's volumes and their issues,
 * built from a SEARCH of openEQUELLA (never from a job file), so it shows
 * what is actually there. Spec: docs/superpowers/specs/2026-11-18-series-index-design.md
 */

/** One item the search returned, as the index needs to see it. */
export interface IndexHit {
  uuid: string;
  version: number;
  /** `live`, `draft`, `archived`, ... as openEQUELLA reports it. */
  status: string;
  /** Null when the server sent none -- production's search omits it. */
  name: string | null;
  /** FILE attachments only, in the item's own order. */
  files: { filename: string; uuid: string }[];
}

export interface IndexIssue {
  label: string;
  url: string;
}

export interface IndexVolume {
  group: number;
  heading: string;
  itemUrl: string;
  /** The volume's item, so the index link can be added to it. */
  uuid: string;
  version: number;
  issues: IndexIssue[];
}

/** A volume the page does not list until a person sorts it out. */
export interface HeldBack {
  /** Null when one item's own files disagree about which volume it is. */
  group: number | null;
  reason: string;
  items: { uuid: string; name: string }[];
}

/** An item the search found that is not one of the series' volumes. */
export interface LeftOut {
  uuid: string;
  name: string;
  reason: string;
}

export interface SeriesIndex {
  volumes: IndexVolume[];
  heldBack: HeldBack[];
  notInSeries: LeftOut[];
}

/** The three files, by the names they are saved and attached under. */
export const INDEX_FILE_NAMES = ['index.html', 'index.css', 'index.js'] as const;
export type IndexFileName = (typeof INDEX_FILE_NAMES)[number];
export type IndexFiles = Record<IndexFileName, string>;
