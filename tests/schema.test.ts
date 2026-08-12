import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  extractDefinition,
  extractItemNamePath,
  parseSchemaPaths,
  validateHeaders,
  suggest,
} from '../src/core/schema.js';

const entity = await readFile('schema/_entity.xml', 'utf8');
const paths = parseSchemaPaths(extractDefinition(entity));

describe('parseSchemaPaths', () => {
  it('finds simple and nested xpaths, excluding the xml root', () => {
    expect(paths.has('MWDL/title')).toBe(true);
    expect(paths.has('MWDL/creators/creator')).toBe(true);
    expect(paths.has('BYUI_extended/byui_rights/restriction')).toBe(true);
    expect(paths.has('BYUI_extended/attachments/attachment')).toBe(true);
    expect(paths.has('xml')).toBe(false);
  });

  it('excludes container elements — only leaf (field) paths are valid xpaths', () => {
    // A container like <creators><creator/></creators> has no field of its
    // own; writing metadata to 'MWDL/creators' would produce
    // <creators>value</creators> instead of the required
    // <creators><creator>value</creator></creators>. Only the leaf is valid.
    expect(paths.has('MWDL/creators')).toBe(false);
    expect(paths.has('BYUI_extended/attachments')).toBe(false);
  });

  it('finds every header used by the real spring 2026 batch', () => {
    for (const h of [
      'MWDL/identifier',
      'BYUI_extended/attachments/attachment',
      'BYUI_extended/byui_rights/restriction',
      'MWDL/creators/creator',
      'MWDL/title',
      'MWDL/description',
      'BYUI_extended/BYUI_information/metadata_complete',
      'BYUI_extended/BYUI_information/course_names/course_name',
      'MWDL/abstract',
    ]) {
      expect(paths.has(h), `${h} should be a valid xpath`).toBe(true);
    }
  });

  it('finds an exact expected path set from a small hand-written definition, independent of the real schema file', () => {
    // Pins parseSchemaPaths' walking behaviour (attributes, arrays, deep
    // nesting, root exclusion, leaf-only filtering) against a minimal
    // fixture, so a change to the real _entity.xml can never mask a
    // regression in the walker itself.
    //
    // Only leaves are valid xpaths: 'A', 'A/c', 'E', 'E/F', 'E/F/G' are all
    // containers (their parsed value is an object, not text), so writing
    // metadata to them would land outside the actual field element. This
    // deliberately updates prior test expectations that asserted containers
    // belonged in the set — that was the bug, not the intended contract.
    const def =
      '<xml>' +
      '<A>' +
      '<b field="true" type="text"/>' +
      '<c><d type="text"/><d type="text"/></c>' +
      '</A>' +
      '<E><F><G><h type="text"/></G></F></E>' +
      '</xml>';
    const result = parseSchemaPaths(def);
    expect(result).toEqual(new Set(['A/b', 'A/c/d', 'E/F/G/h']));
  });

  it('finds a substantial number of paths in the real schema (loose lower bound guards against a silent parser regression)', () => {
    expect(paths.size).toBeGreaterThan(150);
  });
});

/**
 * The declared item name path is what the duplicate check must search on. It
 * is read from the schema, never assumed: `MWDL/title` is only correct here
 * because BYU-Idaho's export happens to declare it.
 */
describe('extractItemNamePath', () => {
  it('reads the declared name path from the real export, in header form', () => {
    expect(extractItemNamePath(entity)).toBe('MWDL/title');
  });

  it('returns null when the export declares none, rather than guessing', () => {
    expect(
      extractItemNamePath(
        '<com.tle.common.ImportExportPack><entity><name>S</name></entity></com.tle.common.ImportExportPack>',
      ),
    ).toBeNull();
  });

  it('reads whatever path the export declares, not a BYU-Idaho one', () => {
    expect(
      extractItemNamePath(
        '<com.tle.common.ImportExportPack><entity><itemNamePath>/local/dc/title</itemNamePath></entity></com.tle.common.ImportExportPack>',
      ),
    ).toBe('local/dc/title');
  });
});

describe('extractDefinition', () => {
  it('throws a clear error when there is no <serialisedDefinition> element', async () => {
    expect(() => extractDefinition('<com.tle.common.ImportExportPack><entity/></com.tle.common.ImportExportPack>')).toThrow(
      /serialisedDefinition/i,
    );
  });
});

describe('validateHeaders', () => {
  it('accepts the reserved attachment column without it being an xpath', () => {
    const result = validateHeaders(['attachment name', 'MWDL/title'], paths);
    expect(result.invalid).toEqual([]);
  });

  it('accepts the reserved attachment column regardless of letter case', () => {
    const result = validateHeaders(['Attachment Name', 'MWDL/title'], paths);
    expect(result.invalid).toEqual([]);
    expect(result.valid).toContain('Attachment Name');
  });

  it('rejects an unknown xpath and suggests the nearest valid one', () => {
    const result = validateHeaders(['MWDL/Title'], paths);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.header).toBe('MWDL/Title');
    expect(result.invalid[0]!.suggestions).toContain('MWDL/title');
  });
});

describe('suggest', () => {
  it('ranks the closest match first', () => {
    expect(suggest('MWDL/creator', paths)[0]).toBe('MWDL/creators/creator');
  });

  it('returns nothing for input with no plausible match', () => {
    expect(suggest('zzzzzzzzzzzzzzzz', paths)).toEqual([]);
  });

  it('does not let a tail-segment match override a much better full-path edit distance', () => {
    // Regression for a real bug: the old scoring treated an exact final-
    // segment match as an unconditional win over every non-matching
    // candidate, so 'MWDL/creators/creators' (a doubled-plural typo, edit
    // distance 1 from the correct answer) surfaced 'MWDL/creators' (edit
    // distance 9) first, purely because both end in a tail matching the
    // input's own second-to-last segment. The tail bonus must be a bounded
    // discount, not a hard override.
    expect(suggest('MWDL/creators/creators', paths)[0]).toBe('MWDL/creators/creator');
  });

  it.each([
    ['MWDL/titel', 'MWDL/title'],
    ['MWDL/descriptions', 'MWDL/description'],
    ['BYUI_extended/byui_rights/restrictions', 'BYUI_extended/byui_rights/restriction'],
    ['mwdl/title', 'MWDL/title'],
    ['MWDL/creators/creators', 'MWDL/creators/creator'],
    ['MWDL/creator', 'MWDL/creators/creator'],
  ])('suggest(%s) ranks %s first', (input, expected) => {
    expect(suggest(input, paths)[0]).toBe(expected);
  });

  it('returns nothing for a schema-shaped but nonexistent field (no false positive)', () => {
    expect(suggest('MWDL/performer', paths)).toEqual([]);
  });
});

// The extractor writes two annotation columns, `_source` and `_notes`, so a
// human can see where each value came from and which rows need a look. They
// are notes to the reader, never metadata. Every document said "the uploader
// ignores them" -- and it did not: it rejected its own output as having
// invalid headers. Found by round-tripping a generated spreadsheet back
// through `oeq-upload plan`, which is the only check that crosses both halves
// of the program.
describe('validateHeaders and annotation columns', () => {
  const paths = new Set(['MWDL/title']);

  it('does not reject a leading-underscore column', () => {
    const { invalid } = validateHeaders(['attachment name', 'MWDL/title', '_source', '_notes'], paths);
    expect(invalid).toEqual([]);
  });

  it('reports annotation columns separately from real metadata', () => {
    const { valid, ignored } = validateHeaders(['MWDL/title', '_notes'], paths);
    expect(valid).toEqual(['MWDL/title']);
    expect(ignored).toEqual(['_notes']);
  });

  it('still rejects a genuine typo', () => {
    const { invalid } = validateHeaders(['MWDL/titel'], paths);
    expect(invalid.map((i) => i.header)).toEqual(['MWDL/titel']);
  });

  it('treats a bare underscore as an annotation, not a typo', () => {
    expect(validateHeaders(['_'], paths).invalid).toEqual([]);
  });
});
