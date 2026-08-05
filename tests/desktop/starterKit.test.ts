import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readSheet } from '../../src/core/sheet.js';
import { extractDefinition, parseSchemaPaths, validateHeaders } from '../../src/core/schema.js';
import {
  resolveResourcePath,
  checkStarterKitDestination,
  STARTER_KIT_FILES,
} from '../../src/desktop/handlers.js';

const templateCsvPath = fileURLToPath(
  new URL('../../resources/template/upload-template.csv', import.meta.url),
);
const sampleFilePath = fileURLToPath(
  new URL('../../resources/template/sample-upload.txt', import.meta.url),
);

/**
 * Catches the template CSV and the sample file drifting apart -- the exact
 * failure mode this starter kit exists to prevent. If someone renames one
 * side without the other, this is the test that turns that into a build
 * failure instead of a silent "no rows matched" the first time a new
 * operator ever tries the kit.
 */
describe('starter-kit template CSV', () => {
  it('parses with readSheet into exactly one row', async () => {
    const sheet = await readSheet(templateCsvPath);
    expect(sheet.rows).toHaveLength(1);
  });

  it("the example row's attachment name matches the sample file exactly", async () => {
    const sheet = await readSheet(templateCsvPath);
    expect(sheet.rows[0]!.cells['attachment name']).toBe('sample-upload.txt');
  });

  it('the referenced sample file exists on disk under that exact name', async () => {
    await expect(readFile(sampleFilePath, 'utf8')).resolves.toContain('safe to delete');
  });

  it('every header is a valid schema xpath (or the reserved attachment-name column) against the real schema', async () => {
    const entity = await readFile('schema/_entity.xml', 'utf8');
    const paths = parseSchemaPaths(extractDefinition(entity));
    const sheet = await readSheet(templateCsvPath);
    const { invalid } = validateHeaders(sheet.headers, paths);
    expect(invalid).toEqual([]);
  });

  it('demonstrates correct CSV quoting: the description contains both a comma and a double quote', async () => {
    const sheet = await readSheet(templateCsvPath);
    const description = sheet.rows[0]!.cells['MWDL/description']!;
    expect(description).toContain(',');
    expect(description).toContain('"');
  });

  it("the example row's title makes an accidental real item unmistakable", async () => {
    const sheet = await readSheet(templateCsvPath);
    expect(sheet.rows[0]!.cells['MWDL/title']).toBe('TEST UPLOAD - safe to delete');
  });
});

describe('resolveResourcePath', () => {
  it('resolves under appPath when unpackaged (development), mirroring resolveSchemaPath', () => {
    const p = resolveResourcePath(
      { isPackaged: false, appPath: 'C:\\repo', resourcesPath: 'C:\\repo\\dist-desktop' },
      'template',
      'upload-template.csv',
    );
    expect(p.replace(/\\/g, '/')).toBe('C:/repo/template/upload-template.csv');
  });

  it('resolves under resourcesPath when packaged, ignoring appPath', () => {
    const p = resolveResourcePath(
      {
        isPackaged: true,
        appPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\app\\resources\\app.asar',
        resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\app\\resources',
      },
      'template',
    );
    expect(p.replace(/\\/g, '/')).toBe(
      'C:/Users/me/AppData/Local/Programs/app/resources/template',
    );
  });
});

describe('checkStarterKitDestination', () => {
  it('is ok when the destination is empty', () => {
    expect(checkStarterKitDestination([])).toEqual({ ok: true });
  });

  it('is ok when the destination has unrelated files only', () => {
    expect(checkStarterKitDestination(['notes.txt', 'other.csv'])).toEqual({ ok: true });
  });

  it('refuses -- naming it -- when the template CSV already exists there', () => {
    expect(checkStarterKitDestination(['upload-template.csv'])).toEqual({
      ok: false,
      conflicts: ['upload-template.csv'],
    });
  });

  it('refuses -- naming it -- when the sample file already exists there', () => {
    expect(checkStarterKitDestination(['sample-upload.txt'])).toEqual({
      ok: false,
      conflicts: ['sample-upload.txt'],
    });
  });

  it('names both files when both already exist, rather than stopping at the first', () => {
    expect(
      checkStarterKitDestination(['upload-template.csv', 'sample-upload.txt', 'unrelated.txt']),
    ).toEqual({ ok: false, conflicts: [...STARTER_KIT_FILES] });
  });

  it('matches file names exactly -- a similarly-named but distinct file is not a conflict', () => {
    expect(checkStarterKitDestination(['Upload-Template.csv'])).toEqual({ ok: true });
  });
});
