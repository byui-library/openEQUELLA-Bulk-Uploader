// src/cli/extract.ts
import { readFile, readdir } from 'node:fs/promises';
import { OeqError, ValidationError } from '../core/errors.js';
import {
  extractDefinition,
  extractItemDescriptionPath,
  extractItemNamePath,
  parseSchemaPaths,
} from '../core/schema.js';
import { loadProfile, saveProfile, validateAgainstSchema } from '../core/extract/profile.js';
import { starterProfile } from '../core/extract/suggest.js';
import { extractFolder } from '../core/extract/extract.js';
import { scanEvidence } from '../core/extract/evidence.js';
import { writeCsv } from '../core/extract/csv.js';

export interface ExtractCliOptions {
  dir: string;
  profile: string;
  out: string;
  schemaFile: string;
  dryRun?: boolean;
  initProfile?: boolean;
}

const PREVIEW_ROWS = 5;

/** `log` is injected so the command is testable without capturing stdout. */
export async function runExtract(
  options: ExtractCliOptions,
  log: (message: string) => void,
): Promise<void> {
  if (options.initProfile) {
    const names = (await readdir(options.dir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
    // Read a sample of the documents, not just their names. Without this the
    // description column came out with NO sources at all and the Word files'
    // "Job Description" table was never mapped -- the CLI produced a profile
    // the desktop app would never have proposed.
    //
    // The declared name and description paths come from the export too, not
    // from a constant: proposing BYU-Idaho's `MWDL/...` against somebody else's
    // schema put three invalid columns in the operator's first output.
    const schemaXml = await readFile(options.schemaFile, 'utf8');
    const profile = starterProfile(
      names,
      {
        titleHeader: extractItemNamePath(schemaXml),
        descriptionHeader: extractItemDescriptionPath(schemaXml),
        paths: parseSchemaPaths(extractDefinition(schemaXml)),
      },
      await scanEvidence(options.dir),
    );
    await saveProfile(options.profile, profile);
    log(`Wrote a starter profile to ${options.profile}`);
    log(`Detected pattern: ${profile.pattern}`);
    log(`Add columns to it, then run extract again without --init-profile.`);
    return;
  }

  const profile = await loadProfile(options.profile);

  const schemaPaths = parseSchemaPaths(extractDefinition(await readFile(options.schemaFile, 'utf8')));
  const problems = validateAgainstSchema(profile, schemaPaths);
  if (problems.length > 0) {
    const detail = problems
      .map((p) => {
        const hint = p.suggestions.length > 0 ? ` -- did you mean ${p.suggestions.join(', ')}?` : '';
        return `  ${p.path}${hint}`;
      })
      .join('\n');
    throw new ValidationError(`Profile has columns that are not valid schema paths:\n${detail}`);
  }

  const result = await extractFolder(options.dir, profile);

  if (result.skipped.length > 0) {
    log(`Skipped ${result.skipped.length} file(s):`);
    for (const { file, reason } of result.skipped) log(`  ${file} -- ${reason}`);
  }

  const withNotes = result.rows.filter((r) => r.notes.length > 0).length;
  if (withNotes > 0) {
    log(`${withNotes} of ${result.rows.length} row(s) need review -- see the _notes column.`);
  }

  if (options.dryRun) {
    log(`Dry run -- nothing written. First ${PREVIEW_ROWS} row(s):`);
    for (const row of result.rows.slice(0, PREVIEW_ROWS)) {
      const cells = profile.columns.map((c) => `${c.path}=${row.cells[c.path] ?? ''}`).join(' | ');
      log(`  ${cells}`);
    }
    return;
  }

  if (result.rows.length === 0) {
    throw new OeqError(`No readable files found in ${options.dir}; nothing to write.`);
  }

  await writeCsv(options.out, profile, result.rows);
  log(`Wrote ${result.rows.length} row(s) to ${options.out}`);
  log(`Open it, check the _notes column, then use it with 'oeq-upload plan'.`);
}
