// src/core/extract/readers/docx.ts
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { ValidationError } from '../../errors.js';
import type { DocumentData, DocumentProperty } from '../types.js';

const CORE_PROPS = 'docProps/core.xml';
const DOCUMENT = 'word/document.xml';

/** Map the Dublin Core names Word uses onto our normalised property names. */
const PROPERTY_KEYS: Record<string, DocumentProperty> = {
  'dc:title': 'title',
  'dc:creator': 'author',
  'dc:subject': 'subject',
  'cp:keywords': 'keywords',
  'dcterms:created': 'created',
};

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

/** Collect the text of every <w:t> in document order, splitting on paragraphs. */
function paragraphText(documentXml: string): string {
  const paragraphs = documentXml.split(/<w:p[ >]/).slice(1);
  return paragraphs
    .map((p) => [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]!).join(''))
    .map((line) => unescapeXml(line))
    .join('\n')
    .trim();
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function readDocx(path: string): Promise<DocumentData> {
  const bytes = await readFile(path);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch (cause) {
    throw new ValidationError(`'${path}' is not a readable .docx file.`, { cause });
  }

  const documentPart = entries[DOCUMENT];
  if (!documentPart) {
    throw new ValidationError(`'${path}' is not a readable .docx file: no ${DOCUMENT} inside.`);
  }

  const properties: Partial<Record<DocumentProperty, string>> = {};
  const corePart = entries[CORE_PROPS];
  if (corePart) {
    const core = parser.parse(strFromU8(corePart)) as Record<string, unknown>;
    const root = core['cp:coreProperties'];
    if (root && typeof root === 'object') {
      for (const [xmlName, key] of Object.entries(PROPERTY_KEYS)) {
        const value = (root as Record<string, unknown>)[xmlName];
        if (typeof value === 'string' && value.trim() !== '') properties[key] = value.trim();
        else if (typeof value === 'number') properties[key] = String(value);
      }
    }
  }

  // A .docx always has a text layer; it may simply be empty. That is a
  // different thing from a scanned PDF, where text is genuinely unavailable.
  return { text: paragraphText(strFromU8(documentPart)), hasTextLayer: true, properties };
}
