// tests/desktop/ui/extract/controller.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createExtractController } from '../../../../src/desktop/ui/extract/controller.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{part1}.pdf',
  columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true }],
};

function api(over: Record<string, unknown> = {}) {
  return {
    chooseFolder: vi.fn(async () => 'C:/files'),
    extractScan: vi.fn(async () => ({ supported: ['a.pdf'], skipped: [], labels: [], properties: [] })),
    extractPreview: vi.fn(async () => []),
    extractRun: vi.fn(async () => ({ outPath: 'C:/files/out.csv', written: 1, flagged: 0 })),
    schemaPaths: vi.fn(async () => ['MWDL/title']),
    openProfile: vi.fn(async () => null),
    saveProfileAs: vi.fn(async () => null),
    chooseCsvPath: vi.fn(async () => 'C:/files/out.csv'),
    ...over,
  };
}

describe('createExtractController', () => {
  it('starts on the folder step', () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    expect(c.state().step).toBe('folder');
  });

  it('scans the folder after one is chosen, and proposes a starter profile', async () => {
    const a = api();
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    expect(a.extractScan).toHaveBeenCalledWith('C:/files');
    expect(c.state().dir).toBe('C:/files');
    expect(c.state().profile?.columns[0]?.path).toBe(ATTACHMENT_COLUMN);
  });

  it('does not advance when the folder holds nothing readable', async () => {
    const a = api({ extractScan: vi.fn(async () => ({ supported: [], skipped: [{ file: 'x.txt', reason: 'r' }], labels: [], properties: [] })) });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    expect(c.state().step).toBe('folder');
  });

  it('refreshes the preview when a column changes', async () => {
    const a = api();
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    a.extractPreview.mockClear();
    await c.addColumn('MWDL/title');
    expect(a.extractPreview).toHaveBeenCalled();
    expect(c.state().profile?.columns.map((x) => x.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/title']);
  });

  it('refuses to remove the locked attachment column and surfaces why', async () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.removeColumn(ATTACHMENT_COLUMN);
    expect(c.state().profile?.columns).toHaveLength(1);
    expect(c.state().error).toMatch(/required/i);
  });

  it('writes the spreadsheet and records where it went', async () => {
    const a = api();
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.continue();
    await c.save();
    expect(a.extractRun).toHaveBeenCalled();
    expect(c.state().savedPath).toBe('C:/files/out.csv');
  });

  it('does nothing when the save dialog is cancelled', async () => {
    const a = api({ chooseCsvPath: vi.fn(async () => null) });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.continue();
    await c.save();
    expect(a.extractRun).not.toHaveBeenCalled();
    expect(c.state().savedPath).toBeNull();
  });

  it('surfaces an IPC failure instead of throwing', async () => {
    const a = api({ extractScan: vi.fn(async () => { throw new Error("Error invoking remote method 'oeq:extractScan': ValidationError: boom"); }) });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    expect(c.state().error).toBe('boom');
  });

  // Going Back to step 1 and re-picking a folder must not throw away the
  // columns the operator has already set up. A mutation pass found that
  // replacing the profile unconditionally broke no test, so the `??` in
  // chooseFolder was load-bearing and unverified.
  it('keeps the columns already set up when the folder is picked again', async () => {
    const a = api();
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.chooseFolder();
    expect(c.state().profile?.columns.map((x) => x.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/title']);
  });

  it('re-renders after every transition', async () => {
    const render = vi.fn();
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render });
    await c.chooseFolder();
    expect(render).toHaveBeenCalled();
  });
});
