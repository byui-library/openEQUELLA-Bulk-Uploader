// src/core/extract/evidence.ts
import { join } from 'node:path';
import { findLabels } from './labels.js';
import { findSections, readSection } from './sections.js';
import { listFolder } from './extract.js';
import { readDocument } from './readers/index.js';
import { DOCUMENT_PROPERTIES, type DocumentData } from './types.js';

/**
 * What a folder offers a profile to read from.
 *
 * This used to live inside the desktop app's IPC handler, which meant the CLI
 * knew none of it: `--init-profile` read only the FILENAMES, so the profile it
 * wrote had an empty description column and no table mappings at all. Every
 * description fix reached the GUI and none of it reached the CLI. Found by the
 * extract -> plan round trip, which planned 14 items with 0 descriptions.
 */
export interface Evidence {
  /** `Label:` names found in the sampled documents. */
  labels: string[];
  /** Document properties present, e.g. ['title', 'created']. */
  properties: string[];
  /** Table headers that have a value beneath them. */
  tableColumns: string[];
  /** Headings that a description could actually be read from. */
  sections: string[];
}

/** How many documents to open when scanning. Enough to see each file type. */
export const SAMPLE_DOCS = 5;

/**
 * Which files to open, spread across the file types present.
 *
 * Taking simply the first N is wrong for a mixed folder: sorted alphabetically,
 * a folder of twelve PDFs and eighteen Word documents gives five PDFs and not
 * one `.docx`, so nothing would learn that those Word files keep their metadata
 * in a table. The operator then sees no table columns offered at all.
 */
export function spreadAcrossTypes(filenames: string[], limit: number): string[] {
  const byExtension = new Map<string, string[]>();
  for (const name of filenames) {
    const extension = (name.split('.').pop() ?? '').toLowerCase();
    (byExtension.get(extension) ?? byExtension.set(extension, []).get(extension)!).push(name);
  }

  const chosen: string[] = [];
  const queues = [...byExtension.values()];
  // Round-robin, so each type is represented before any type gets a second.
  for (let i = 0; chosen.length < limit && queues.some((q) => q.length > i); i++) {
    for (const queue of queues) {
      if (chosen.length >= limit) break;
      const next = queue[i];
      if (next !== undefined) chosen.push(next);
    }
  }
  return chosen;
}

/** What a set of already-read documents offers. */
export function evidenceFrom(docs: DocumentData[]): Evidence {
  const labels = new Set<string>();
  const properties = new Set<string>();
  const tableColumns = new Set<string>();
  const sections = new Set<string>();

  for (const doc of docs) {
    for (const label of findLabels(doc.text).keys()) labels.add(label);

    // Only headings with text under them. A document ending at "Abstract"
    // would otherwise offer a mapping that is blank on every row.
    for (const heading of findSections(doc.text)) {
      if (readSection(doc.text, heading).text !== '') sections.add(heading);
    }

    for (const key of DOCUMENT_PROPERTIES) {
      if (doc.properties[key] !== undefined) properties.add(key);
    }

    // Only headers that have a value under them. A header with an empty cell
    // in every sampled document would offer a mapping that is always blank.
    for (const table of doc.tables) {
      table.headers.forEach((header, i) => {
        if (header.trim() !== '' && (table.rows[0]?.[i] ?? '').trim() !== '') {
          tableColumns.add(header.trim());
        }
      });
    }
  }

  return {
    labels: [...labels].sort(),
    properties: [...properties],
    tableColumns: [...tableColumns].sort(),
    sections: [...sections],
  };
}

/**
 * Open a sample of a folder and report what it offers.
 *
 * A file that will not open is skipped rather than thrown: it is already
 * reported by the caller's own listing, and one bad file must not leave the
 * whole folder looking empty.
 */
export async function scanEvidence(dir: string, limit = SAMPLE_DOCS): Promise<Evidence> {
  const { supported } = await listFolder(dir);
  const docs: DocumentData[] = [];
  for (const filename of spreadAcrossTypes(supported, limit)) {
    try {
      docs.push(await readDocument(join(dir, filename)));
    } catch {
      // Reported elsewhere as a skipped file.
    }
  }
  return evidenceFrom(docs);
}
