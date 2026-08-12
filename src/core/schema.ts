import { XMLParser } from 'fast-xml-parser';
import { ValidationError } from './errors.js';

/**
 * The definition text embedded in an _entity.xml export is XML-escaped XML:
 * every `<`, `>`, and `"` inside it becomes `&lt;`, `&gt;`, `&quot;`. A real
 * schema has ~200 elements, each contributing several such entities, which
 * blows past fast-xml-parser's default entity-expansion guard (1000 total
 * expansions, meant to defend against billion-laughs-style attacks on
 * untrusted input). The real _entity.xml in this repo needs 1192. These
 * bounds are raised, not removed: 20,000 expansions is >16x that observed
 * figure (headroom for schema growth, including a future live fetch from the
 * API rather than a local file), and 10 MB is >1000x the real definition's
 * 7.8 KB. A schema that blows past either bound is not a case of "the schema
 * grew a bit" — it's almost certainly a decompression-bomb-shaped input, and
 * the guard should still fire.
 */
const parserOptions = {
  ignoreAttributes: true,
  processEntities: {
    processEntities: true,
    maxTotalExpansions: 20_000,
    maxExpandedLength: 10_000_000,
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
 * The path an exported schema declares as the item's name, in spreadsheet-header
 * form (`MWDL/title`, no leading slash) -- or null when the export declares
 * none.
 *
 * THE DUPLICATE CHECK SEARCHES ON THIS. The XML export spells it
 * `<itemNamePath>`; the REST representation spells the same thing `namePath`
 * and is parsed by discovery.ts#parseSchema. Both exist so a front end can read
 * the declared path from whichever source it has, rather than assuming
 * BYU-Idaho's `MWDL/title` -- an assumption that makes the check match nothing
 * anywhere else and report every row clean.
 *
 * Null is returned rather than a fallback, deliberately: findDuplicates turns
 * an unknown path into `could-not-check`, which is the only honest answer.
 */
export function extractItemNamePath(entityXml: string): string | null {
  const parser = new XMLParser(parserOptions);
  const doc = parser.parse(entityXml) as Record<string, unknown>;
  const pack = doc['com.tle.common.ImportExportPack'] as Record<string, unknown> | undefined;
  const entity = pack?.['entity'] as Record<string, unknown> | undefined;
  const declared = entity?.['itemNamePath'];
  if (typeof declared !== 'string' || declared.trim() === '') return null;
  return declared.trim().replace(/^\/+/, '');
}

/**
 * Walk the definition tree and collect every *leaf* element path below the
 * <xml> root — the paths that actually hold a value. A container element
 * (e.g. 'MWDL/creators', wrapping one-or-more <creator> children) is not
 * itself a valid xpath: writing metadata there would produce
 * <creators>value</creators> instead of the schema-required
 * <creators><creator>value</creator></creators>. With `ignoreAttributes:
 * true`, a node is a leaf iff its parsed value is not an object — a
 * self-closing or text-only tag comes back as a string (possibly '').
 *
 * One accepted edge case: a tag that has both a `type="text"` attribute AND
 * a child element (e.g. this schema's `item/oai`) is genuinely ambiguous —
 * ignoring attributes means it parses as an object and is treated as a
 * container, so it is excluded. That fails loud (via a "not a valid xpath"
 * suggestion) rather than silently accepting metadata that may not land
 * where intended. No real batch header touches the `item/` subtree.
 */
export function parseSchemaPaths(definitionXml: string): Set<string> {
  const parser = new XMLParser(parserOptions);
  const doc = parser.parse(definitionXml) as Record<string, unknown>;
  const root = doc['xml'];
  const out = new Set<string>();

  const isLeaf = (value: unknown): boolean => value === null || typeof value !== 'object';

  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}/${key}` : key;
      // A repeated sibling tag (e.g. two <d/> under the same parent) comes
      // back from fast-xml-parser as an array; each occurrence is checked
      // independently since one instance being a leaf doesn't guarantee
      // another is.
      if (Array.isArray(value)) {
        for (const v of value) {
          if (isLeaf(v)) out.add(path);
          else walk(v, path);
        }
      } else if (isLeaf(value)) {
        out.add(path);
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
 * Plausibility cutoff for the (possibly discounted, see TAIL_BONUS below)
 * normalizedDistance score, chosen so that garbage input (e.g. a header
 * that isn't even schema-shaped) returns no suggestions rather than the
 * three least-bad matches, while a real typo still surfaces its intended
 * target.
 */
const PLAUSIBLE_THRESHOLD = 0.35;

/**
 * Bounded discount applied to a candidate's score when its final path
 * segment matches the header's final segment case-insensitively. The final
 * segment is almost always the field name itself (e.g. 'creator', 'title'),
 * so an exact hit there is good evidence of intent even when the rest of
 * the path is wrong — e.g. 'MWDL/creator' should suggest
 * 'MWDL/creators/creator', not a closer-by-raw-distance but semantically
 * unrelated path.
 *
 * This must be a *bounded* discount, not a rank override: an earlier version
 * let any tail match unconditionally outrank any non-match, which meant a
 * badly-off candidate (edit distance 9) beat the actually-correct one (edit
 * distance 1) whenever both happened to share a final segment with the
 * input — e.g. 'MWDL/creators/creators' (a doubled-plural typo) wrongly
 * topped out at a same-tailed container instead of the one-letter-away
 * correct field. Subtracting a small, fixed amount instead means a tail
 * match can only close a moderate gap — it can never let a much worse edit
 * distance win outright.
 */
const TAIL_BONUS = 0.15;

/** Similarity score used to rank a candidate: lower is better. */
function score(headerLower: string, pathLower: string): number {
  const base = normalizedDistance(headerLower, pathLower);
  const tailMatches = lastSegment(headerLower) === lastSegment(pathLower);
  return tailMatches ? Math.max(0, base - TAIL_BONUS) : base;
}

/**
 * Rank schema paths by similarity to `header`, closest first, capped at
 * `limit`. Returns [] when nothing is plausibly close — see
 * PLAUSIBLE_THRESHOLD above.
 */
export function suggest(header: string, paths: Set<string>, limit = 3): string[] {
  const headerLower = header.toLowerCase();

  const scored = [...paths]
    .map((path) => ({ path, score: score(headerLower, path.toLowerCase()) }))
    .filter(({ score }) => score <= PLAUSIBLE_THRESHOLD);

  scored.sort((x, y) => x.score - y.score);

  return scored.slice(0, limit).map((s) => s.path);
}

export interface InvalidHeader {
  header: string;
  suggestions: string[];
}

export interface HeaderValidation {
  valid: string[];
  invalid: InvalidHeader[];
  /**
   * Annotation columns such as `_source` and `_notes`: carried through
   * untouched and never treated as metadata. Separate from `valid` because
   * they are not schema paths and must not be reported as though they were.
   */
  ignored: string[];
}

/** The reserved column naming the file on disk; never a metadata xpath. */
const RESERVED = new Set(['attachment name']);

/**
 * A column whose name starts with `_` is an annotation for the person reading
 * the spreadsheet, not metadata. The extractor writes `_source` (where each
 * value came from) and `_notes` (which rows need a look).
 *
 * They are carried through validation untouched and contribute nothing to the
 * item. Before this existed the uploader rejected its own extractor's output
 * as having invalid headers, while every document claimed it ignored them --
 * found by round-tripping a generated spreadsheet through `oeq-upload plan`.
 */
export function isAnnotationHeader(header: string): boolean {
  return header.startsWith('_');
}

export function validateHeaders(headers: string[], paths: Set<string>): HeaderValidation {
  const valid: string[] = [];
  const invalid: InvalidHeader[] = [];
  const ignored: string[] = [];
  for (const h of headers) {
    if (isAnnotationHeader(h)) ignored.push(h);
    else if (RESERVED.has(h.toLowerCase()) || paths.has(h)) valid.push(h);
    else invalid.push({ header: h, suggestions: suggest(h, paths) });
  }
  return { valid, invalid, ignored };
}
