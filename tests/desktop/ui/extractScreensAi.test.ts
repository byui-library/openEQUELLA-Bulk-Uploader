// tests/desktop/ui/extractScreensAi.test.ts
import { describe, it, expect } from 'vitest';
import { renderExtractColumns, type ExtractColumnsProps } from '../../../src/desktop/ui/screens/extractColumns.js';
import { renderExtractSave, type ExtractSaveProps } from '../../../src/desktop/ui/screens/extractSave.js';
import { FakeElement } from '../../helpers/fakeDom.js';
import { ATTACHMENT_COLUMN, type ExtractedRow, type Profile } from '../../../src/core/extract/types.js';

/**
 * ## The rendered call sites, not the helpers behind them
 *
 * `previewReviewCount` and `countNeedingReview` are both tested directly, and
 * both mutations at the CALL SITES survived a full run anyway: reverting
 * `previewReviewCount(props.preview)` to the old `notes.length > 0` filter, and
 * deleting the entire model-written sentence from the save screen, each left the
 * suite green. A helper nothing calls is a helper that does nothing, and
 * `renderExtractSave` had no test of any kind.
 *
 * This project deliberately has no jsdom; `tests/helpers/fakeDom.ts` is the
 * stand-in, as `results.test.ts` already uses.
 */

const AI_NOTE = 'MWDL/description: written by a language model from the document text.';

const profile: Profile = {
  version: 1,
  pattern: '{part1}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/description', sources: [{ ai: true }] },
  ],
};

const modelWrote = (file: string): ExtractedRow => ({
  cells: { [ATTACHMENT_COLUMN]: file, 'MWDL/description': 'A description.' },
  sources: { 'MWDL/description': 'ai' },
  notes: [AI_NOTE],
  flagged: {},
  aiWritten: { 'MWDL/description': { note: AI_NOTE, factField: false } },
});

const broken = (file: string, note: string): ExtractedRow => ({
  cells: { [ATTACHMENT_COLUMN]: file, 'MWDL/description': '' },
  sources: {},
  notes: [note],
  flagged: {},
  aiWritten: {},
});

function columns(preview: ExtractedRow[]): string {
  const root = new FakeElement();
  const props: ExtractColumnsProps = {
    profile,
    profilePath: null,
    sampleFilename: 'a.pdf',
    scan: { labels: [], properties: [], tableColumns: [], sections: [] },
    preview,
    busy: false,
    error: null,
    onPatternChange: () => {},
    onSourceChange: () => {},
    onDefaultChange: () => {},
    onRemove: () => {},
    onMove: () => {},
    onAdd: () => {},
    removed: null,
    onUndoRemove: () => {},
    onOpenProfile: () => {},
    onSaveProfile: () => {},
    onContinue: () => {},
    onBack: () => {},
  };
  renderExtractColumns(root as unknown as HTMLElement, props);
  return root.innerHTML;
}

describe('the preview heading and what a model wrote', () => {
  /**
   * The heading is the operator's triage number at the moment they decide
   * whether to look. With a model on one column every row carries a note, so an
   * unsubtracted count reads "5 need review" for a preview in which nothing went
   * wrong -- and the batch's one real failure stops standing out.
   */
  it('does not announce a review for a row a model merely wrote', () => {
    expect(columns([modelWrote('a.pdf'), modelWrote('b.pdf')])).not.toContain('need review');
  });

  it('still announces a genuine problem', () => {
    const html = columns([modelWrote('a.pdf'), broken('b.pdf', 'no text layer')]);
    expect(html).toContain('1 need review');
  });

  /**
   * THE LIST IS NOT SUBTRACTED, and that is deliberate. The flag on a
   * model-written cell is the whole argument for letting a model write into a
   * permanent catalogue at all; hiding it at the moment of decision would be
   * worse than miscounting.
   */
  it('still shows the model note itself', () => {
    const html = columns([modelWrote('a.pdf')]);
    expect(html).toContain('written by a language model');
    expect(html).toContain('a.pdf');
  });
});

function saved(over: Partial<ExtractSaveProps> = {}): string {
  const root = new FakeElement();
  const props: ExtractSaveProps = {
    fileCount: 4,
    flagged: 0,
    aiWritten: 0,
    savedPath: 'C:/files/out.csv',
    busy: false,
    error: null,
    onSave: () => {},
    onBack: () => {},
    onOpenFolder: () => {},
    onDone: () => {},
    ...over,
  };
  renderExtractSave(root as unknown as HTMLElement, props);
  return root.innerHTML;
}

describe('the save screen and what a model wrote', () => {
  it('says nothing about a model when none ran', () => {
    const html = saved();
    expect(html).toContain('None need review');
    expect(html).not.toMatch(/language model/i);
  });

  /**
   * A MACHINE WROTE TEXT THAT IS ABOUT TO BECOME A PERMANENT RECORD, and this
   * is the last screen before the operator opens the file. Saying nothing here
   * would be this project's other recurring fault: work that happened and was
   * never reported.
   */
  it('reports the rows a model wrote into', () => {
    const html = saved({ aiWritten: 3 });
    expect(html).toMatch(/language model/i);
    expect(html).toContain('3');
  });

  /** And it asks for the one thing no assertion in this repository can do. */
  it('asks for them to be checked against the documents', () => {
    expect(saved({ aiWritten: 3 })).toMatch(/check them against the documents/i);
  });

  /** Two numbers, two sentences: "what must I fix" and "what did a machine
   *  write" are different questions, and folding them together buries the
   *  first. */
  it('reports a real problem separately from a model write', () => {
    const html = saved({ flagged: 2, aiWritten: 3 });
    expect(html).toContain('2');
    expect(html).toContain('need review');
    expect(html).toMatch(/language model/i);
    expect(html).not.toContain('None need review');
  });

  /** Before the run there is no report, so neither number is claimed. */
  it('claims neither number before anything has been written', () => {
    const html = saved({ savedPath: null, flagged: 0, aiWritten: 0 });
    expect(html).not.toContain('need review');
    expect(html).not.toMatch(/language model/i);
  });
});
