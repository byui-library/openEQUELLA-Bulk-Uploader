// src/core/seriesIndex/collect.ts
import { readName, resolveLabels } from '../extract/sequenceChecks.js';
import type { SequenceLabels } from '../extract/types.js';
import { instanceEndpoint } from '../instanceUrl.js';
import type { HeldBack, IndexHit, IndexVolume, LeftOut, SeriesIndex } from './types.js';

/**
 * Search hits -> the series' volumes. PURE.
 *
 * NEVER GUESSES. Two items claiming one volume, or one item whose files name
 * two, is HELD BACK and named: nothing here can know which copy is right, and
 * a page offering both -- or a silently chosen one -- is worse than a gap a
 * person can see. An item no pattern fits is LISTED as not in the series.
 *
 * Draft and live are listed alike (operator, 2026-11-18): an item's links do
 * not change with its state. A withdrawn item is left out, saying so.
 */

export interface IndexRule {
  /** The template's `checks.sequence.patterns` -- each has {part}. */
  patterns: readonly string[];
  /** The template's `index.groupPatterns` -- tried after `patterns`. */
  groupPatterns?: readonly string[];
  labels?: Partial<SequenceLabels>;
}

const LISTED = new Set(['live', 'draft']);

/** The item, at whatever its latest version is (`/items/{uuid}/0/`, checked live 2026-11-17). */
export function itemUrl(base: string, uuid: string): string {
  return instanceEndpoint(base, `items/${encodeURIComponent(uuid)}/0/`).href;
}

/** One of its files, at the latest version. */
export function fileUrl(base: string, uuid: string, filename: string): string {
  return instanceEndpoint(base, `items/${encodeURIComponent(uuid)}/0/${encodeURIComponent(filename)}`).href;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stem = (filename: string) => filename.replace(/\.[^.]+$/, '');
const isRun = (parts: number[]) => parts.every((p, i) => i === 0 || p === parts[i - 1]! + 1);

type Read = ReturnType<typeof readName>;

/** "Issue 2 (1972)", "Issues 2–3", or the file's stem when it states no part. */
export function issueLabel(read: Read, filename: string, labels: SequenceLabels): string {
  if (!read || read.parts.length === 0) return stem(filename);
  const parts = read.parts;
  const numbers =
    parts.length === 1 ? `${parts[0]}` : isRun(parts) ? `${parts[0]}–${parts[parts.length - 1]}` : parts.join(', ');
  const word = capital(parts.length === 1 ? labels.part : labels.parts);
  const years = read.years
    ? ` (${read.years.from === read.years.to ? read.years.from : `${read.years.from}–${read.years.to}`})`
    : '';
  return `${word} ${numbers}${years}`;
}

export function collectIndex(hits: readonly IndexHit[], rule: IndexRule, base: string): SeriesIndex {
  const labels = resolveLabels(rule.labels);
  const patterns = [...rule.patterns, ...(rule.groupPatterns ?? [])];
  const notInSeries: LeftOut[] = [];
  const heldBack: HeldBack[] = [];
  const byGroup = new Map<number, { hit: IndexHit; reads: Read[] }[]>();
  const nameOf = (hit: IndexHit) => hit.name?.trim() || hit.uuid;

  for (const hit of hits) {
    if (!LISTED.has(hit.status)) {
      notInSeries.push({ uuid: hit.uuid, name: nameOf(hit), reason: `its status is ${hit.status}` });
      continue;
    }
    const reads = hit.files.map((f) => readName(patterns, f.filename));
    const groups = [...new Set(reads.flatMap((r) => (r && r.group !== null ? [r.group] : [])))].sort(
      (a, b) => a - b,
    );
    if (groups.length === 0) {
      notInSeries.push({
        uuid: hit.uuid,
        name: nameOf(hit),
        reason: "none of its files fits the template's file-name patterns",
      });
      continue;
    }
    if (groups.length > 1) {
      heldBack.push({
        group: null,
        reason: `its files name more than one ${labels.group}: ${groups.join(', ')}`,
        items: [{ uuid: hit.uuid, name: nameOf(hit) }],
      });
      continue;
    }
    const group = groups[0]!;
    byGroup.set(group, [...(byGroup.get(group) ?? []), { hit, reads }]);
  }

  const volumes: IndexVolume[] = [];
  for (const group of [...byGroup.keys()].sort((a, b) => a - b)) {
    const claims = byGroup.get(group)!;
    if (claims.length > 1) {
      heldBack.push({
        group,
        reason: `${claims.length} items claim ${labels.group} ${group}`,
        items: claims.map((c) => ({ uuid: c.hit.uuid, name: nameOf(c.hit) })),
      });
      continue;
    }
    const { hit, reads } = claims[0]!;
    volumes.push({
      group,
      heading: hit.name?.trim() || `${capital(labels.group)} ${group}`,
      itemUrl: itemUrl(base, hit.uuid),
      issues: hit.files.map((f, i) => ({
        label: issueLabel(reads[i] ?? null, f.filename, labels),
        url: fileUrl(base, hit.uuid, f.filename),
      })),
    });
  }
  return { volumes, heldBack, notInSeries };
}
