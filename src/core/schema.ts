import { XMLParser } from 'fast-xml-parser';
import { ValidationError } from './errors.js';

/**
 * The definition text embedded in an _entity.xml export is XML-escaped XML:
 * every `<`, `>`, and `"` inside it becomes `&lt;`, `&gt;`, `&quot;`. A real
 * schema has ~200 elements, each contributing several such entities, which
 * blows past fast-xml-parser's default entity-expansion guard (1000 total
 * expansions, meant to defend against billion-laughs-style attacks on
 * untrusted input). This file is trusted — it's a schema the caller exported
 * from their own openEQUELLA instance — so both limits are disabled.
 */
const parserOptions = {
  ignoreAttributes: true,
  processEntities: {
    processEntities: true,
    maxTotalExpansions: Infinity,
    maxExpandedLength: Infinity,
  },
} as const;

/** Pull the schema definition XML out of an exported _entity.xml. */
export function extractDefinition(entityXml: string): string {
  const parser = new XMLParser(parserOptions);
  const doc = parser.parse(entityXml) as Record<string, unknown>;
  const pack = doc['com.tle.common.ImportExportPack'] as Record<string, unknown> | undefined;
  const entity = pack?.['entity'] as Record<string, unknown> | undefined;
  const def = entity?.['serialisedDefinition'];
  if (typeof def !== 'string' || def.length === 0) {
    throw new ValidationError(
      'No <serialisedDefinition> found in entity XML; is this a valid openEQUELLA schema export?',
    );
  }
  return def;
}

/**
 * Walk the definition tree and collect every element path below the <xml>
 * root, including intermediate container paths (e.g. 'MWDL/creators' as well
 * as 'MWDL/creators/creator') — a container element's own path is a legal
 * xpath in openEQUELLA even when only its children carry `field="true"`.
 */
export function parseSchemaPaths(definitionXml: string): Set<string> {
  const parser = new XMLParser(parserOptions);
  const doc = parser.parse(definitionXml) as Record<string, unknown>;
  const root = doc['xml'];
  const out = new Set<string>();

  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}/${key}` : key;
      out.add(path);
      // A repeated sibling tag (e.g. two <d/> under the same parent) comes
      // back from fast-xml-parser as an array; everything else — including a
      // leaf with no children, which parses to '' — is handled by the base
      // case at the top of walk.
      if (Array.isArray(value)) {
        for (const v of value) walk(v, path);
      } else {
        walk(value, path);
      }
    }
  };

  walk(root, '');
  return out;
}

/** Levenshtein distance, iterative two-row form. */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Edit distance as a fraction of the longer string's length: 0 = identical, ~1 = unrelated. */
function normalizedDistance(a: string, b: string): number {
  const denom = Math.max(a.length, b.length, 1);
  return distance(a, b) / denom;
}

/** The part of a path after its last '/', or the whole string if there is none. */
function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Plausibility cutoffs for normalizedDistance, chosen so that garbage input
 * (e.g. a header that isn't even schema-shaped) returns no suggestions
 * rather than the three least-bad matches, while a real typo still surfaces
 * its intended target.
 *
 * A header whose final path segment matches a candidate's final segment
 * case-insensitively (TAIL_MATCH_THRESHOLD) gets a much looser bound: the
 * final segment is almost always the field name itself (e.g. 'creator',
 * 'title'), so an exact hit there is strong, near-decisive evidence of
 * intent even if the rest of the path is wrong — e.g. 'MWDL/creator' means
 * 'MWDL/creators/creator', not the more edit-distance-similar but semantically
 * unrelated container path 'MWDL/creators'. Without a header that plausible,
 * only near-identical full paths (DEFAULT_THRESHOLD) count — this is what
 * catches pure case/typo mistakes like 'MWDL/Title' -> 'MWDL/title'.
 */
const TAIL_MATCH_THRESHOLD = 0.6;
const DEFAULT_THRESHOLD = 0.35;

/**
 * Rank schema paths by similarity to `header`, closest first, capped at
 * `limit`. Returns [] when nothing is plausibly close — see the threshold
 * comments above.
 */
export function suggest(header: string, paths: Set<string>, limit = 3): string[] {
  const headerLower = header.toLowerCase();
  const headerTail = lastSegment(headerLower);

  const scored = [...paths].map((path) => {
    const pathLower = path.toLowerCase();
    const tailMatches = lastSegment(pathLower) === headerTail;
    const score = normalizedDistance(headerLower, pathLower);
    return { path, tailMatches, score };
  });

  const plausible = scored.filter(({ tailMatches, score }) =>
    tailMatches ? score <= TAIL_MATCH_THRESHOLD : score <= DEFAULT_THRESHOLD,
  );

  // Tail-matching candidates always outrank non-tail-matching ones,
  // regardless of raw distance; within each group, closer wins.
  plausible.sort((x, y) => {
    if (x.tailMatches !== y.tailMatches) return x.tailMatches ? -1 : 1;
    return x.score - y.score;
  });

  return plausible.slice(0, limit).map((s) => s.path);
}

export interface InvalidHeader {
  header: string;
  suggestions: string[];
}

export interface HeaderValidation {
  valid: string[];
  invalid: InvalidHeader[];
}

/** The reserved column naming the file on disk; never a metadata xpath. */
const RESERVED = new Set(['attachment name']);

export function validateHeaders(headers: string[], paths: Set<string>): HeaderValidation {
  const valid: string[] = [];
  const invalid: InvalidHeader[] = [];
  for (const h of headers) {
    if (RESERVED.has(h.toLowerCase()) || paths.has(h)) valid.push(h);
    else invalid.push({ header: h, suggestions: suggest(h, paths) });
  }
  return { valid, invalid };
}
