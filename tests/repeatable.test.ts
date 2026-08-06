// tests/repeatable.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { isRepeatable, splitRepeatable } from '../src/core/metadata.js';
import { extractDefinition, parseSchemaPaths } from '../src/core/schema.js';

describe('isRepeatable', () => {
  it('recognises a plural container holding its own singular', () => {
    expect(isRepeatable('MWDL/creators/creator')).toBe(true);
    expect(isRepeatable('MWDL/subjects/subject')).toBe(true);
    expect(isRepeatable('MWDL/alternativeTitles/alternativeTitle')).toBe(true);
  });

  it('does not treat an unrelated child of a plural-looking parent as repeatable', () => {
    // 'rights' is not the plural of 'description'. A semicolon in a rights
    // statement is punctuation, not a separator.
    expect(isRepeatable('MWDL/rights/description')).toBe(false);
    expect(isRepeatable('MWDL/formats/medium')).toBe(false);
  });

  it('does not treat a single-segment or top-level field as repeatable', () => {
    expect(isRepeatable('MWDL/title')).toBe(false);
    expect(isRepeatable('MWDL/description')).toBe(false);
    expect(isRepeatable('attachment name')).toBe(false);
  });

  // Pins exactly which of the real schema's 158 paths this rule selects, so the
  // set cannot drift silently when the rule or the schema changes.
  it('selects exactly these paths from the real schema', async () => {
    const xml = await readFile('schema/_entity.xml', 'utf8');
    const selected = [...parseSchemaPaths(extractDefinition(xml))].filter(isRepeatable).sort();
    expect(selected).toEqual([
      'BYUI_extended/BYUI_information/administrative_offices/administrative_office',
      'BYUI_extended/BYUI_information/assignment_types/assignment_type',
      'BYUI_extended/BYUI_information/buildings/building',
      'BYUI_extended/BYUI_information/course_councils/course_council',
      'BYUI_extended/BYUI_information/course_groups/course_group',
      'BYUI_extended/BYUI_information/course_names/course_name',
      'BYUI_extended/BYUI_information/delivery_modes/delivery_mode',
      'BYUI_extended/BYUI_information/department_ids/department_id',
      'BYUI_extended/BYUI_information/folder_names/folder_name',
      'BYUI_extended/BYUI_information/lessons/lesson',
      'BYUI_extended/BYUI_information/module_types/module_type',
      'BYUI_extended/BYUI_information/notes/note',
      'BYUI_extended/activities/activities_areas/activities_area',
      'BYUI_extended/attachments/attachment',
      'BYUI_extended/av/entry_ids/entry_id',
      'BYUI_extended/photography/locations/location',
      'BYUI_extended/spori/conditions/condition',
      'BYUI_extended/spori/dimensions/dimension',
      'BYUI_extended/spori/external_urls/external_url',
      'BYUI_extended/spori/locations/location',
      'BYUI_extended/spori/qr_codes/qr_code',
      'BYUI_extended/spori/values/value',
      'HBCS/Best_Seller_Flags/Best_Seller_Flag',
      'HBCS/Geographic_Settings/Geographic_Setting',
      'HBCS/Industry_Settings/Industry_Setting',
      'MWDL/alternativeTitles/alternativeTitle',
      'MWDL/audiences/audience',
      'MWDL/contributors/contributor',
      'MWDL/creators/creator',
      'MWDL/formats/format',
      'MWDL/genres/genre',
      'MWDL/isRequiredBys/isRequiredBy',
      'MWDL/languages/language',
      'MWDL/subjects/subject',
      'MWDL/types/type',
    ]);
  });
});

describe('splitRepeatable', () => {
  it('splits a repeatable field on semicolons', () => {
    expect(splitRepeatable('MWDL/creators/creator', 'Ibáñez; Rico-González; Pino-Ortega')).toEqual([
      'Ibáñez',
      'Rico-González',
      'Pino-Ortega',
    ]);
  });

  it('leaves a comma alone, because a comma is part of a name', () => {
    expect(splitRepeatable('MWDL/creators/creator', 'Dixon, Matt')).toEqual(['Dixon, Matt']);
  });

  it('does not split a field that is not repeatable', () => {
    expect(splitRepeatable('MWDL/description', 'Ran 3 tests; all passed')).toEqual([
      'Ran 3 tests; all passed',
    ]);
  });

  it('trims each part and drops empty ones', () => {
    expect(splitRepeatable('MWDL/subjects/subject', ' Violin ;; Cello ; ')).toEqual([
      'Violin',
      'Cello',
    ]);
  });

  it('keeps a single value as a single value', () => {
    expect(splitRepeatable('MWDL/creators/creator', 'Xiangyu Ren')).toEqual(['Xiangyu Ren']);
  });

  it('preserves an empty cell rather than producing nothing', () => {
    expect(splitRepeatable('MWDL/creators/creator', '')).toEqual(['']);
    expect(splitRepeatable('MWDL/creators/creator', ' ; ; ')).toEqual([' ; ; ']);
  });
});
