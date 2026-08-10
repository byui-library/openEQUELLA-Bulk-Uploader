// tests/extract/templates.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { listTemplates, loadTemplate } from '../../src/core/extract/templates.js';
import { parseProfile } from '../../src/core/extract/profile.js';
import { buildRow } from '../../src/core/extract/rows.js';
import { extractDefinition, parseSchemaPaths } from '../../src/core/schema.js';
import { ATTACHMENT_COLUMN, type DocumentData } from '../../src/core/extract/types.js';

const DEATH = 'BYUI_extended/BYUI_information/special_collections/alumni_obituary/death_date';
const doc = (text: string): DocumentData => ({ text, hasTextLayer: true, properties: {}, tables: [] });

describe('shipped templates', () => {
  it('lists the alumni obituary template', async () => {
    expect((await listTemplates()).map((t) => t.id)).toContain('alumni-obituary');
  });

  it('gives it a name a person can read', async () => {
    const found = (await listTemplates()).find((t) => t.id === 'alumni-obituary');
    expect(found?.label).toBe('Alumni Obituary');
  });

  it('loads as a valid profile', async () => {
    const raw = JSON.parse(await readFile('templates/alumni-obituary.profile.json', 'utf8'));
    expect(() => parseProfile(raw)).not.toThrow();
  });

  /**
   * A template naming an xpath the schema does not have would fail at upload,
   * long after the operator built the batch.
   */
  it('names only real schema paths', async () => {
    const paths = parseSchemaPaths(extractDefinition(await readFile('schema/_entity.xml', 'utf8')));
    for (const column of (await loadTemplate('alumni-obituary')).columns) {
      if (column.path === ATTACHMENT_COLUMN) continue;
      expect(paths.has(column.path), `${column.path} is not in the schema`).toBe(true);
    }
  });

  it('extracts a death date and composes a description', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Clyde Williams Obituary.pdf',
      doc('Clyde L Williams graduated this world on January 9, 2024. He was born April 3, 1935.'),
    );
    expect(row.cells[DEATH]).toBe('2024-01-09');
    expect(row.cells['MWDL/description']).toBe('Died 2024-01-09; Born 1935-04-03');
    expect(row.cells['MWDL/title']).toBe('Alumni Obituary: Clyde Williams');
    expect(row.cells['MWDL/genres/genre']).toBe('Alumni Obituary');
  });

  it('adds the Ricks College connection when the document mentions it', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Clyde Williams Obituary.pdf',
      doc('Clyde L Williams died January 9, 2024. He continued his education at Ricks College.'),
    );
    expect(row.cells['MWDL/description']).toBe('Died 2024-01-09; Attended Ricks College');
  });

  /**
   * The birth date and the Ricks connection are extracted so the description
   * can read them, and must not become columns of their own: the schema has no
   * birth-date field, so a column would write a person's birth date into one
   * that means something else, permanently.
   */
  it('never writes its composeOnly columns as cells', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Clyde Williams Obituary.pdf',
      doc('He died January 9, 2024, was born April 3, 1935, and attended Ricks College.'),
    );
    expect(row.cells['MWDL/description']).toContain('Born 1935-04-03');
    expect(row.cells['MWDL/coverage']).toBeUndefined();
    expect(row.cells['MWDL/relation']).toBeUndefined();
  });

  // Each clause disappears on its own, so a partial document never yields
  // "Died 2024-01-09; ; Attended Ricks College".
  it('drops only the parts it could not find', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Dennis Birch Obituary.pdf',
      doc('Dennis Jack Birch January 14, 1953 January 1, 2024. He lived in Rexburg.'),
    );
    expect(row.cells['MWDL/description']).toBe('Died 2024-01-01; Born 1953-01-14');
  });

  it('leaves the date blank rather than guessing when none is stated', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Brandon Lythoe Obituary.pdf',
      doc('Brandon Lythgoe passed away peacefully in the early hours of Saturday morning.'),
    );
    expect(row.cells[DEATH]).toBe('');
    expect(row.notes.join(' ')).toContain('Lythoe');
    expect(row.notes.join(' ')).toContain('alumni_obituary/death_date');
  });

  it('rejects an unknown template id rather than returning a broken profile', async () => {
    await expect(loadTemplate('no-such-template')).rejects.toThrow();
  });

  /**
   * The id crosses IPC from the renderer. Without the guard, a traversal like
   * '../../package' would be read and parsed.
   */
  it('refuses an id that is not a template name', async () => {
    await expect(loadTemplate('../../package')).rejects.toThrow(/Not a template name/);
  });
});
