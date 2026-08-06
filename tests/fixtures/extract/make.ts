// tests/fixtures/extract/make.ts
import { zipSync, strToU8 } from 'fflate';

/**
 * Build a minimal but genuinely valid PDF. Object offsets are computed as the
 * body is assembled, so the xref table is correct -- pdf.js will parse this
 * the same way it parses a real file, which is the entire point of using it
 * instead of a stub.
 */
export function makePdf(options: {
  text?: string;
  title?: string;
  author?: string;
  /** Raw PDF date syntax, e.g. "D:20260803230446+00'00'" -- what real PDFs contain. */
  created?: string;
}): Uint8Array {
  const { text, title, author, created } = options;

  /**
   * A PDF text string. Plain `(parens)` are PDFDocEncoding — a Latin-1
   * relative — so raw UTF-8 bytes in one are read back as mojibake. Non-ASCII
   * goes in as a UTF-16BE hex string with a BOM, which is what real PDF
   * writers emit and what pdf.js expects.
   *
   * Worth stating because the first version of this fixture wrote UTF-8 into
   * parentheses and produced "IbÃ¡Ã±ez" — a fixture that was wrong in a way no
   * real PDF is, which would have made a correct reader look broken.
   */
  const pdfString = (s: string): string => {
    if (/^[\x20-\x7E]*$/.test(s)) return `(${s.replace(/([\\()])/g, '\\$1')})`;
    const utf16be = [...s].flatMap((ch) => {
      const code = ch.codePointAt(0)!;
      if (code <= 0xffff) return [code];
      const v = code - 0x10000;
      return [0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)];
    });
    const hex = ['FEFF', ...utf16be.map((u) => u.toString(16).padStart(4, '0').toUpperCase())].join('');
    return `<${hex}>`;
  };
  const content = text === undefined ? '' : `BT /F1 12 Tf 72 720 Td ${pdfString(text)} Tj ET`;

  const info: string[] = [];
  if (title !== undefined) info.push(`/Title ${pdfString(title)}`);
  if (author !== undefined) info.push(`/Author ${pdfString(author)}`);
  if (created !== undefined) info.push(`/CreationDate ${pdfString(created)}`);

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< ${info.join(' ')} >>`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return strToU8(body + xref + trailer);
}

const xmlText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * A Word table, as `<w:tbl>` really nests it: rows of cells, each cell holding
 * one or more paragraphs. Cells are given as `\n`-separated strings so a
 * fixture can reproduce the multi-paragraph cells real documents contain --
 * which is the case that makes flattening to lines lossy.
 */
function tableXml(rows: string[][]): string {
  const cell = (content: string): string =>
    `<w:tc>${content
      .split('\n')
      .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlText(p)}</w:t></w:r></w:p>`)
      .join('')}</w:tc>`;
  return `<w:tbl>${rows.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`;
}

/** Build a minimal but valid .docx: a zip holding the two parts we read. */
export function makeDocx(options: {
  text?: string;
  title?: string;
  creator?: string;
  /** Rows of a table, header row first. A cell may contain `\n` for several paragraphs. */
  table?: string[][];
}): Uint8Array {
  const { text = '', title, creator, table } = options;

  const paragraphs =
    text
      .split('\n')
      .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlText(line)}</w:t></w:r></w:p>`)
      .join('') + (table === undefined ? '' : tableXml(table));

  const core =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    (title === undefined ? '' : `<dc:title>${title}</dc:title>`) +
    (creator === undefined ? '' : `<dc:creator>${creator}</dc:creator>`) +
    `</cp:coreProperties>`;

  const document =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${paragraphs}</w:body></w:document>`;

  return zipSync({
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    ),
    'docProps/core.xml': strToU8(core),
    'word/document.xml': strToU8(document),
  });
}
