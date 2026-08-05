// src/core/extract/readers/index.ts
import { extname } from 'node:path';
import { ValidationError } from '../../errors.js';
import type { DocumentData } from '../types.js';
import { readPdf } from './pdf.js';
import { readDocx } from './docx.js';

export const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx']);

export function isSupported(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase());
}

/** A reader, so orchestration can be tested without touching real files. */
export type DocumentReader = (path: string) => Promise<DocumentData>;

export const readDocument: DocumentReader = async (path) => {
  const extension = extname(path).toLowerCase();
  if (extension === '.pdf') return readPdf(path);
  if (extension === '.docx') return readDocx(path);
  if (extension === '.doc') {
    throw new ValidationError(
      `.doc files (Word 2003 and earlier) cannot be read. Open them in Word and save as .docx first.`,
    );
  }
  throw new ValidationError(`Cannot read '${extension || 'a file with no extension'}'.`);
};
