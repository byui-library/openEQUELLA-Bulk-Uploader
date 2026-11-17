import { describe, it, expect } from 'vitest';
import { renderExtractFolder, type ExtractFolderProps } from '../../../src/desktop/ui/screens/extractFolder.js';
import { FakeElement } from '../../helpers/fakeDom.js';

const scan = (supported: string[], perFolder = false) => ({
  supported,
  skipped: [],
  labels: [],
  properties: [],
  tableColumns: [],
  sections: [],
  starter: { version: 1 as const, pattern: '{part1}', columns: [] },
  ...(perFolder ? { perFolder: true } : {}),
});

function render(over: Partial<ExtractFolderProps> = {}) {
  const root = new FakeElement();
  const switched: boolean[] = [];
  renderExtractFolder(root as unknown as HTMLElement, {
    dir: 'C:/batch',
    scan: scan(['a.pdf']) as never,
    busy: false,
    error: null,
    canContinue: true,
    templates: [],
    templateId: '',
    perFolder: false,
    onChooseFolder: () => {},
    onTemplateChange: () => {},
    onPerFolderChange: (on) => switched.push(on),
    onContinue: () => {},
    onCancel: () => {},
    ...over,
  });
  return { root, switched };
}

describe('extract folder screen -- one row per subfolder', () => {
  it('offers the switch once a folder is chosen, unchecked by default', () => {
    const { root } = render();
    expect(root.has('#extract-per-folder')).toBe(true);
    expect(root.innerHTML).toContain('One row per subfolder');
    expect(root.innerHTML).not.toMatch(/id="extract-per-folder"[^>]*checked/);
  });

  it('does not offer it before a folder is chosen', () => {
    expect(render({ dir: null, scan: null }).root.has('#extract-per-folder')).toBe(false);
  });

  it('reports the change', () => {
    const { root, switched } = render();
    root.fire('#extract-per-folder', 'change', { target: { checked: true } });
    expect(switched).toEqual([true]);
  });

  it('counts folders, not files, when on', () => {
    const { root } = render({ perFolder: true, scan: scan(['V1', 'V2'], true) as never });
    expect(root.innerHTML).toMatch(/id="extract-per-folder"[^>]*checked/);
    expect(root.innerHTML).toContain('<strong>2</strong> folder(s) will become items');
  });

  it('says no subfolder can become an item when there are none', () => {
    const { root } = render({ perFolder: true, scan: scan([], true) as never });
    expect(root.innerHTML).toContain('No subfolder here can become an item');
  });

  it('carries no inline style -- the CSP would drop it', () => {
    expect(render({ perFolder: true }).root.innerHTML).not.toMatch(/style\s*=/);
  });
});

import { renderExtractSave, type ExtractSaveProps } from '../../../src/desktop/ui/screens/extractSave.js';

describe('extract save screen -- the problems log', () => {
  function renderSave(over: Partial<ExtractSaveProps> = {}) {
    const root = new FakeElement();
    let opened = 0;
    renderExtractSave(root as unknown as HTMLElement, {
      fileCount: 36,
      flagged: 0,
      aiWritten: 0,
      savedPath: 'C:/batch/sre.csv',
      problems: { path: 'C:/batch/sre-problems.csv', heldBack: 2, looseFiles: 0, notes: 3 },
      busy: false,
      modelStatus: null,
      error: null,
      onSave: () => {},
      onBack: () => {},
      onOpenFolder: () => {},
      onOpenProblems: () => (opened += 1),
      onDone: () => {},
      ...over,
    });
    return { root, opened: () => opened };
  }

  it('says how many folders were held back, and offers the list', () => {
    const { root, opened } = renderSave();
    expect(root.innerHTML).toContain('<strong>2</strong> folder(s) were held back');
    expect(root.innerHTML).toContain('<strong>3</strong> note(s)');
    root.fire('#extract-open-problems');
    expect(opened()).toBe(1);
  });

  it('says nothing about a log when the run had none (one row per file)', () => {
    const { root } = renderSave({ problems: null });
    expect(root.has('#extract-open-problems')).toBe(false);
  });
});

describe('extract save screen -- a log of loose files only', () => {
  it('says the loose files were left out, and never that nothing was found', () => {
    const root = new FakeElement();
    renderExtractSave(root as unknown as HTMLElement, {
      fileCount: 3,
      flagged: 0,
      aiWritten: 0,
      savedPath: 'C:/batch/sre.csv',
      problems: { path: 'C:/batch/sre-problems.csv', heldBack: 0, looseFiles: 1, notes: 0 },
      busy: false,
      modelStatus: null,
      error: null,
      onSave: () => {},
      onBack: () => {},
      onOpenFolder: () => {},
      onOpenProblems: () => {},
      onDone: () => {},
    });
    expect(root.innerHTML).toContain('<strong>1</strong> file(s) lie loose');
    expect(root.innerHTML).not.toContain('No problems were found');
  });
});
