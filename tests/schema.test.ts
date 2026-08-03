import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extractDefinition, parseSchemaPaths, validateHeaders, suggest } from '../src/core/schema.js';

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
    // nesting, root exclusion) against a minimal fixture, so a change to the
    // real _entity.xml can never mask a regression in the walker itself.
    const def =
      '<xml>' +
      '<A>' +
      '<b field="true" type="text"/>' +
      '<c><d type="text"/><d type="text"/></c>' +
      '</A>' +
      '<E><F><G><h type="text"/></G></F></E>' +
      '</xml>';
    const result = parseSchemaPaths(def);
    expect(result).toEqual(
      new Set(['A', 'A/b', 'A/c', 'A/c/d', 'E', 'E/F', 'E/F/G', 'E/F/G/h']),
    );
  });

  it('finds a substantial number of paths in the real schema (loose lower bound guards against a silent parser regression)', () => {
    expect(paths.size).toBeGreaterThan(150);
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
});
