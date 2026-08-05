// src/core/extract/readers/pdf.ts
import { readFile } from 'node:fs/promises';
import { ValidationError } from '../../errors.js';
import type { DocumentData, DocumentProperty } from '../types.js';

/**
 * A page of a scanned document sometimes carries a few stray characters from
 * a header stamp or a watermark. Treating that as "has a text layer" would
 * send a row down the label-matching path with nothing to match, so require
 * a minimum before believing it.
 */
const MIN_TEXT_LAYER_CHARS = 12;

/**
 * PDF stores dates as `D:YYYYMMDDHHmmSSOHH'mm'` -- everything after the year
 * is optional. This is not an unusual case to handle, it is the only case: a
 * real folder produced `D:20260803230446+00'00'` on every single file, which
 * nothing downstream could make sense of.
 *
 * Converted here rather than in `normaliseDate` because the syntax is a PDF
 * concern, and the reader is the only layer that knows the value came from a
 * PDF. A value that does not match is returned untouched -- never dropped.
 *
 * A date carrying only a year stays a bare year rather than gaining an
 * invented January the 1st; `normaliseDate` then keeps it verbatim and says
 * so, which is the honest outcome.
 */
function fromPdfDate(raw: string): string {
  const match = /^D:(\d{4})(?:(\d{2})(\d{2}))?/.exec(raw);
  if (!match) return raw;

  const [, year, month, day] = match;
  if (month === undefined || day === undefined) return year!;

  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return raw;

  return `${year}-${month}-${day}`;
}

const PROPERTY_KEYS: Record<string, DocumentProperty> = {
  Title: 'title',
  Author: 'author',
  Subject: 'subject',
  Keywords: 'keywords',
  CreationDate: 'created',
};

interface TextItem {
  str?: string;
}

type PdfModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
/** `getDocument` returns a loading task; its `promise` property resolves to the document. */
type PdfDocument = Awaited<ReturnType<PdfModule['getDocument']>['promise']>;

/**
 * pdf.js ships a browser build by default; the `legacy` build is the one that
 * runs under Node. Imported lazily so that nothing pays its startup cost
 * unless a PDF is actually read.
 */
async function pdfjs(): Promise<PdfModule> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

export async function readPdf(path: string): Promise<DocumentData> {
  const bytes = await readFile(path);
  const { getDocument } = await pdfjs();

  // In pdfjs-dist 6.x, `destroy()` lives on the loading task returned by
  // `getDocument()`, not on the resolved `PDFDocumentProxy` (`.promise`) --
  // the resolved document only exposes `cleanup()`. Keep the task so it can
  // be torn down properly.
  //
  // `isEvalSupported` no longer exists as an option in 6.x (removed from
  // `DocumentInitParameters` along with the eval-based code paths it used to
  // gate); only `useSystemFonts` remains from the plan's original call.
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
  });

  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (cause) {
    throw new ValidationError(`'${path}' is not a readable PDF.`, { cause });
  }

  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(
        (content.items as TextItem[])
          .map((item) => item.str ?? '')
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim(),
      );
    }

    const text = pages.join('\n').trim();

    const properties: Partial<Record<DocumentProperty, string>> = {};
    const metadata = await doc.getMetadata();
    const info = (metadata.info ?? {}) as Record<string, unknown>;
    for (const [pdfName, key] of Object.entries(PROPERTY_KEYS)) {
      const value = info[pdfName];
      if (typeof value !== 'string' || value.trim() === '') continue;
      const trimmed = value.trim();
      properties[key] = key === 'created' ? fromPdfDate(trimmed) : trimmed;
    }

    return { text, hasTextLayer: text.length >= MIN_TEXT_LAYER_CHARS, properties };
  } finally {
    await task.destroy();
  }
}
