// tests/extract/templates.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      'Marcus Fennel Obituary.pdf',
      doc('Marcus T Fennel graduated this world on March 5, 2019. He was born November 13, 1907.'),
    );
    expect(row.cells[DEATH]).toBe('2019-03-05');
    expect(row.cells['MWDL/description']).toBe('Died 2019-03-05; Born 1907-11-13');
    expect(row.cells['MWDL/title']).toBe('Alumni Obituary: Marcus Fennel');
    expect(row.cells['MWDL/genres/genre']).toBe('Alumni Obituary');
  });

  it('adds the Ricks College connection when the document mentions it', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Marcus Fennel Obituary.pdf',
      doc('Marcus T Fennel died March 5, 2019. He continued his education at Ricks College.'),
    );
    expect(row.cells['MWDL/description']).toBe('Died 2019-03-05; Attended Ricks College');
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
      'Marcus Fennel Obituary.pdf',
      doc('He died March 5, 2019, was born November 13, 1907, and attended Ricks College.'),
    );
    expect(row.cells['MWDL/description']).toContain('Born 1907-11-13');
    expect(row.cells['MWDL/coverage']).toBeUndefined();
    expect(row.cells['MWDL/relation']).toBeUndefined();
  });

  // Each clause disappears on its own, so a partial document never yields
  // "Died 2019-03-05; ; Attended Ricks College".
  it('drops only the parts it could not find', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Corwin Teasel Obituary.pdf',
      doc('Corwin Ames Teasel August 14, 1951 May 1, 2019. He lived in Elmsgate.'),
    );
    expect(row.cells['MWDL/description']).toBe('Died 2019-05-01; Born 1951-08-14');
  });

  it('leaves the date blank rather than guessing when none is stated', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Alden Larkspar Obituary.pdf',
      doc('Alden Larkspur died quietly at home on an afternoon at the end of the harvest.'),
    );
    expect(row.cells[DEATH]).toBe('');
    expect(row.notes.join(' ')).toContain('Larkspar');
    expect(row.notes.join(' ')).toContain('alumni_obituary/death_date');
  });

  it('rejects an unknown template id rather than returning a broken profile', async () => {
    await expect(loadTemplate('no-such-template')).rejects.toThrow();
  });

  describe('the model is offered where it helps and nowhere else', () => {
    it('asks for a model on the description, after the deterministic sources', async () => {
      const profile = await loadTemplate('alumni-obituary');
      const description = profile.columns.find((c) => c.path === 'MWDL/description');
      const sources = description?.sources ?? [];
      expect(sources.some((s) => 'ai' in s)).toBe(true);
      // Last, so every deterministic source has its turn first. The rule does
      // not depend on order, but a reader of the profile should see the
      // intended precedence.
      expect('ai' in (sources[sources.length - 1] ?? {})).toBe(true);
    });

    /**
     * A death date is a FACT. A model that fills one produces something no
     * reviewer can distinguish from a real one, in a collection with no
     * moderation queue. Prose only, in this release.
     */
    it('asks for a model on no other column', async () => {
      const profile = await loadTemplate('alumni-obituary');
      const asked = profile.columns.filter((c) => c.sources.some((s) => 'ai' in s)).map((c) => c.path);
      expect(asked).toEqual(['MWDL/description']);
    });

    /**
     * A MODEL-WRITTEN DESCRIPTION AND A COMPOSED ONE MUST LOOK ALIKE IN THE
     * CATALOGUE. The compose source produces `Died <iso>; Born <iso>; Attended
     * Ricks College`, dropping any clause it could not fill, and the model is
     * asked for the same shape rather than left to invent a format -- otherwise
     * one batch reads one way and the next reads another, in a permanent record
     * nobody re-edits.
     *
     * EVERY EXPECTATION IS DERIVED FROM THE PROFILE, none hardcoded. An earlier
     * version of this test checked that the instruction contained the literals
     * `Died` and `Born` plus a hardcoded /Attended Ricks College/, which caught
     * a reworded compose verb and nothing else: not a reordered instruction, not
     * a changed date format, and -- worst -- not a dropped evidence clause. Its
     * commit message claimed the two "cannot drift apart silently", which was
     * more than it did.
     */
    it('asks the model for the same shape the compose source produces', async () => {
      const profile = await loadTemplate('alumni-obituary');
      const compose = profile.columns
        .find((c) => c.path === 'MWDL/description')
        ?.sources.find((s) => 'compose' in s);
      const template = compose && 'compose' in compose ? compose.compose : '';
      const instruction = profile.aiInstruction ?? '';
      expect(template, 'the description column no longer composes').not.toBe('');
      expect(instruction, 'the template carries no aiInstruction').not.toBe('');

      // IN ORDER, not merely present. An instruction listing the clauses the
      // other way round yields descriptions that do not match the composed ones
      // sitting beside them in the same collection, which is the whole thing
      // the house style exists to prevent.
      let cursor = 0;
      for (const literal of template
        .split(/\{[^}]*\}/)
        .map((part) => part.replace(/[;\s]+/g, ' ').trim())) {
        if (literal === '') continue;
        const at = instruction.indexOf(literal, cursor);
        expect(at, `aiInstruction is missing '${literal}', or has it out of order`).toBeGreaterThanOrEqual(0);
        cursor = at + literal.length;
      }

      for (const name of [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!)) {
        const column = profile.columns.find((c) => c.as === name);
        expect(column, `compose reads {${name}} but no column is named that`).toBeDefined();

        // A `date` transform emits ISO, so the instruction has to ask for ISO.
        // Without this, changing the transform leaves the model writing one
        // format beside composed cells written in another.
        if (column!.transform === 'date') {
          expect(instruction, 'a composed column emits ISO dates and aiInstruction does not ask for them')
            .toContain('YYYY-MM-DD');
        }

        for (const source of column!.sources) {
          if (!('presence' in source)) continue;

          // The clause's own words, from the profile rather than from memory.
          expect(instruction, `aiInstruction never mentions the '${source.presence.then}' clause`)
            .toContain(source.presence.then);

          // AND WHAT LICENSES IT. This is the assertion that matters most in
          // the file. The shipped instruction ends "Include the last clause
          // only if the document says the person attended Ricks College or
          // BYU-Idaho"; drop that sentence and a model is invited to append a
          // claim about a real person's education to a permanent catalogue
          // record with no moderation queue, on no evidence at all.
          //
          // The clause text is removed before looking, because it CONTAINS one
          // of the trigger phrases -- "Attended Ricks College" holds "Ricks
          // College" -- so a naive search passes on an instruction that states
          // the clause and gates it on nothing.
          const beyondTheClause = instruction.split(source.presence.then).join(' ');
          expect(
            source.presence.any.some((term) => beyondTheClause.includes(term)),
            `aiInstruction states the '${source.presence.then}' clause but never says what ` +
              `evidence licenses it -- name one of ${source.presence.any.join(', ')}`,
          ).toBe(true);
        }
      }
    });
  });

  /**
   * The id crosses IPC from the renderer. Without the guard, a traversal like
   * '../../package' would be read and parsed.
   */
  it('refuses an id that is not a template name', async () => {
    await expect(loadTemplate('../../package')).rejects.toThrow(/Not a template name/);
  });
});

/**
 * Listing and loading have to agree about what a template id is. They did not:
 * listTemplates returned every `*.profile.json` basename while loadTemplate
 * rejects anything outside `[a-z0-9-]+`, so a file saved as
 * `Alumni_Obituary.profile.json` appeared in the picker and then failed the
 * moment the operator chose it -- an offer the app could not honour.
 */
describe('listTemplates', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oeq-templates-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Real profile content, so a listed id genuinely loads rather than
   *  failing validation for an unrelated reason. */
  const put = async (name: string) =>
    writeFile(join(dir, name), await readFile('templates/alumni-obituary.profile.json', 'utf8'));

  it('lists an id loadTemplate accepts', async () => {
    await put('alumni-obituary.profile.json');
    expect((await listTemplates(dir)).map((t) => t.id)).toEqual(['alumni-obituary']);
  });

  it('omits a file whose name loadTemplate would refuse', async () => {
    await put('good-one.profile.json');
    await put('Alumni_Obituary.profile.json');
    await put('faculty content.profile.json');
    await put('.profile.json');

    expect((await listTemplates(dir)).map((t) => t.id)).toEqual(['good-one']);
  });

  it('offers nothing it cannot then load', async () => {
    await put('Alumni_Obituary.profile.json');
    await put('spaced out.profile.json');
    await put('alumni-obituary.profile.json');

    const listed = await listTemplates(dir);
    expect(listed).toHaveLength(1);
    for (const { id } of listed) {
      await expect(loadTemplate(id, dir)).resolves.toBeDefined();
    }
  });

  it('still ignores files that are not profiles at all', async () => {
    await put('notes.txt');
    await put('good-one.profile.json');
    expect((await listTemplates(dir)).map((t) => t.id)).toEqual(['good-one']);
  });
});
