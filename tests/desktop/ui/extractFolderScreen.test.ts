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
