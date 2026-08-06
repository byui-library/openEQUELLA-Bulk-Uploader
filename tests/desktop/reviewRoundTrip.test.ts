// tests/desktop/reviewRoundTrip.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportColumns } from '../../src/desktop/handlers.js';
import { extractFolder } from '../../src/core/extract/extract.js';
import { writeCsv } from '../../src/core/extract/csv.js';
import { starterProfile } from '../../src/core/extract/suggest.js';
import { readSheet } from '../../src/core/sheet.js';
import { buildManifest } from '../../src/core/plan.js';
import { extractDefinition, parseSchemaPaths } from '../../src/core/schema.js';
import { makePdf, makeDocx } from '../fixtures/extract/make.js';

/**
 * The round trip: a spreadsheet the extractor produced, fed straight back into
 * the uploader, with no hand-editing in between.
 *
 * This is the boundary the two halves of the program meet at, and each half
 * passed its own tests for weeks while disagreeing about it. The extractor
 * writes `_source` and `_notes` annotation columns; the uploader rejected the
 * whole file as having invalid headers, while three documents claimed it
 * ignored them. Nothing either half tested could see that, because each was
 * tested against its own idea of the format.
 *
 * Native file dialogs cannot be scripted, so the *picker* still needs a human.
 * Everything behind it — reading the file, validating the headers, building the
 * manifest, and what the Review screen renders — is exercised here against a
 * genuinely generated spreadsheet, not a hand-written fixture that could encode
 * the same assumption twice.
 */

async function schemaPaths(): Promise<Set<string>> {
  return parseSchemaPaths(extractDefinition(await readFile('schema/_entity.xml', 'utf8')));
}

/** Extract a real folder to a real CSV, exactly as the desktop flow does. */
async function extractToCsv(): Promise<{ dir: string; csvPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-roundtrip-'));
  await writeFile(join(dir, 'Ibanez_Sergio_Recital.pdf'), makePdf({ text: 'x', title: 'A Recital', author: 'Sergio J. Ibáñez, Markel Rico and José Pino' }));
  await writeFile(join(dir, 'Ash_Quinn_Jury.docx'), makeDocx({ text: 'y', title: 'A Jury', creator: 'Dixon, Matt' }));

  const profile = starterProfile(['Ibanez_Sergio_Recital.pdf', 'Ash_Quinn_Jury.docx']);
  const { rows } = await extractFolder(dir, profile);
  const csvPath = join(dir, 'extracted.csv');
  await writeCsv(csvPath, profile, rows);
  return { dir, csvPath };
}

describe('extract → upload round trip', () => {
  it('the uploader reads a spreadsheet the extractor wrote', async () => {
    const { csvPath } = await extractToCsv();
    const sheet = await readSheet(csvPath);
    expect(sheet.rows).toHaveLength(2);
    // The byte-order mark that makes Excel read accents correctly must not
    // reach the first header. It corrupts the FIRST field only, which is a
    // uniquely confusing failure.
    expect(sheet.headers[0]).toBe('attachment name');
  });

  it('the Review screen finds no invalid column in it', async () => {
    const { csvPath } = await extractToCsv();
    const sheet = await readSheet(csvPath);
    const report = reportColumns(sheet.headers, await schemaPaths());
    const rejected = report.filter((c) => !c.valid).map((c) => c.header);
    expect(rejected, `Review would reject: ${rejected.join(', ')}`).toEqual([]);
  });

  it('shows the annotation columns as ignored rather than as metadata', async () => {
    const { csvPath } = await extractToCsv();
    const sheet = await readSheet(csvPath);
    const report = reportColumns(sheet.headers, await schemaPaths());
    const annotations = report.filter((c) => c.header.startsWith('_'));
    expect(annotations.map((c) => c.header).sort()).toEqual(['_notes', '_source']);
    // Valid, but not metadata -- saying only "valid" would imply these get
    // uploaded, and they do not.
    expect(annotations.every((c) => c.ignored === true)).toBe(true);
  });

  it('plans a manifest from it with no annotation column in any item', async () => {
    const { dir, csvPath } = await extractToCsv();
    const sheet = await readSheet(csvPath);
    const manifest = await buildManifest(sheet, dir, await schemaPaths(), {
      baseUrl: 'https://example.invalid',
      collectionUuid: 'c',
      schemaUuid: 's',
      itemState: 'draft',
    });

    expect(manifest.entries).toHaveLength(2);
    for (const entry of manifest.entries) {
      const leaked = Object.keys(entry.metadata).filter((k) => k.startsWith('_'));
      expect(leaked, `${entry.fileName} carries ${leaked.join(', ')}`).toEqual([]);
    }
  });

  it('carries several authors through as separate values', async () => {
    const { dir, csvPath } = await extractToCsv();
    const sheet = await readSheet(csvPath);
    const manifest = await buildManifest(sheet, dir, await schemaPaths(), {
      baseUrl: 'https://example.invalid',
      collectionUuid: 'c',
      schemaUuid: 's',
      itemState: 'draft',
    });

    const pdf = manifest.entries.find((e) => e.fileName.endsWith('.pdf'))!;
    expect(pdf.metadata['MWDL/creators/creator']).toEqual([
      'Sergio J. Ibáñez',
      'Markel Rico',
      'José Pino',
    ]);

    // "Dixon, Matt" is one person written surname-first. It must arrive as one
    // creator, not two.
    const docx = manifest.entries.find((e) => e.fileName.endsWith('.docx'))!;
    expect(docx.metadata['MWDL/creators/creator']).toEqual(['Dixon, Matt']);
  });
});
