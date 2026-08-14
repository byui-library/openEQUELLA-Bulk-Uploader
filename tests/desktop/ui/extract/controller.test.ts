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
    extractScan: vi.fn(async () => ({ supported: ['a.pdf'], skipped: [], labels: [], properties: [], tableColumns: [], starter: { version: 1 as const, pattern: '{part1}.pdf', columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true as const }], locked: true }] } })),
    extractPreview: vi.fn(async () => []),
    extractRun: vi.fn(async () => ({ outPath: 'C:/files/out.csv', written: 1, flagged: 0 })),
    schemaPaths: vi.fn(async () => ['MWDL/title']),
    schemaNamePath: vi.fn(async () => '/MWDL/title'),
    listTemplates: vi.fn(async () => []),
    loadTemplate: vi.fn(async () => profile),
    openProfile: vi.fn(async () => null),
    saveProfileAs: vi.fn(async () => null),
    chooseCsvPath: vi.fn(async () => 'C:/files/out.csv'),
    // The shipped state: no endpoint configured anywhere. Present in the base
    // fake rather than left undefined so a test that does not care about the
    // model exercises the real "nothing is configured" path, instead of the
    // catch that covers an unreadable store -- two different states that a
    // missing method would silently merge into one.
    getModel: vi.fn(async () => null),
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
    // The second argument names whose schema the columns are checked against;
    // no instance was given here, so it is empty and the main process falls
    // back to the bundled export.
    expect(a.extractScan).toHaveBeenCalledWith('C:/files', '');
    expect(c.state().dir).toBe('C:/files');
    expect(c.state().profile?.columns[0]?.path).toBe(ATTACHMENT_COLUMN);
  });

  /**
   * Extraction still touches no network -- this only names WHOSE already
   * cached schema the main process should validate against. Without it every
   * institution's columns are checked against the schema export bundled with
   * the app, which is BYU-Idaho's and correct nowhere else.
   */
  it('tells the main process which instance’s schema to validate against', async () => {
    const a = api();
    const c = createExtractController({
      api: a as never,
      instanceId: 'https://other.example.edu',
      onExit: vi.fn(),
      render: vi.fn(),
    });
    await c.chooseFolder();
    expect(a.extractScan).toHaveBeenCalledWith('C:/files', 'https://other.example.edu');
    expect(a.schemaPaths).toHaveBeenCalledWith('https://other.example.edu');
    expect(a.schemaNamePath).toHaveBeenCalledWith('https://other.example.edu');
  });

  it('does not advance when the folder holds nothing readable', async () => {
    const a = api({ extractScan: vi.fn(async () => ({ supported: [], skipped: [{ file: 'x.txt', reason: 'r' }], labels: [], properties: [], tableColumns: [], starter: { version: 1 as const, pattern: '{part1}.pdf', columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true as const }], locked: true }] } })) });
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

/** Flushes the microtask queue so the fire-and-forget listTemplates().then(...) in the controller has run. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('templates', () => {
  it('lists templates when the flow starts, without waiting for a folder to be chosen', async () => {
    const a = api({
      listTemplates: vi.fn(async () => [{ id: 'alumni-obituary', label: 'Alumni Obituary' }]),
    });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await flush();
    expect(a.listTemplates).toHaveBeenCalled();
    expect(c.state().templates).toEqual([{ id: 'alumni-obituary', label: 'Alumni Obituary' }]);
  });

  it('offers no templates, rather than breaking the flow, when listing them fails', async () => {
    const a = api({
      listTemplates: vi.fn(async () => {
        throw new Error('ENOENT: no templates directory');
      }),
    });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await flush();
    expect(c.state().templates).toEqual([]);
    expect(c.state().error).toBeNull();
  });

  it('loads the chosen template as the working profile', async () => {
    const templateProfile: Profile = {
      version: 1,
      pattern: '{a}.pdf',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/title', sources: [{ placeholder: 'a' }] },
      ],
    };
    const a = api({ loadTemplate: vi.fn(async () => templateProfile) });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.setTemplate('alumni-obituary');
    expect(a.loadTemplate).toHaveBeenCalledWith('alumni-obituary');
    expect(c.state().profile).toEqual(templateProfile);
    expect(c.state().templateId).toBe('alumni-obituary');
  });

  it('returns to the scanned starter, unchanged, when the generic option is chosen again', async () => {
    const templateProfile: Profile = {
      version: 1,
      pattern: '{a}.pdf',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/title', sources: [{ placeholder: 'a' }] },
      ],
    };
    const a = api({ loadTemplate: vi.fn(async () => templateProfile) });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    const starter = c.state().profile;
    await c.setTemplate('alumni-obituary');
    expect(c.state().profile).toEqual(templateProfile);
    await c.setTemplate('');
    expect(c.state().profile).toEqual(starter);
    expect(c.state().templateId).toBe('');
    expect(a.loadTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('add-column picker', () => {
  it('opens and closes', async () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    c.openAdd();
    expect(c.state().adding).toBe(true);
    c.closeAdd();
    expect(c.state().adding).toBe(false);
  });

  it('clears the query when it closes, so it does not reopen pre-filtered', async () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    c.openAdd();
    c.setAddQuery('title');
    c.closeAdd();
    expect(c.state().addQuery).toBe('');
  });

  it('closes after adding a column', async () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    c.openAdd();
    await c.addColumn('MWDL/title');
    expect(c.state().adding).toBe(false);
  });
});

describe('undo a removed column', () => {
  const withColumns = () => api({
    schemaPaths: vi.fn(async () => ['MWDL/title', 'MWDL/date']),
  });

  it('remembers what was removed, and from where', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.addColumn('MWDL/date');
    await c.removeColumn('MWDL/title');
    expect(c.state().removed?.column.path).toBe('MWDL/title');
    expect(c.state().removed?.index).toBe(1);
  });

  it('puts the column back at its original index, not on the end', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.addColumn('MWDL/date');
    await c.removeColumn('MWDL/title');
    await c.undoRemove();
    expect(c.state().profile?.columns.map((x) => x.path)).toEqual([
      ATTACHMENT_COLUMN, 'MWDL/title', 'MWDL/date',
    ]);
  });

  it('clears the undo once it has been used, so it cannot fire twice', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.removeColumn('MWDL/title');
    await c.undoRemove();
    expect(c.state().removed).toBeNull();
    await c.undoRemove();
    expect(c.state().profile?.columns.filter((x) => x.path === 'MWDL/title')).toHaveLength(1);
  });

  it('does not record an undo for a removal that was refused', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.removeColumn(ATTACHMENT_COLUMN);
    expect(c.state().removed).toBeNull();
  });

  it('forgets the undo when a different edit is made', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.removeColumn('MWDL/title');
    await c.addColumn('MWDL/date');
    expect(c.state().removed).toBeNull();
  });
});

/**
 * ## Where the confirmation goes, and why it is here rather than on the screen
 *
 * The plan named `screens/extractColumns.ts`. That screen's Continue does not
 * run an extract -- it advances from the columns step to the save step, and the
 * operator can still go Back from there without a single file having been read.
 * A confirmation there would name a send that has not been decided on yet, and
 * ask for approval of something the operator may never do.
 *
 * `save()` is the only point "before the extract runs": it picks the output
 * path and calls `extractRun`, and that call is where the model pass will
 * happen (Task 11). It is also the only place with an api to ask whether an
 * endpoint is even configured; the screen is a pure render function with no
 * such reach.
 *
 * NOTHING IS UPLOADED FROM HERE, which is what makes the dialog's closing
 * sentence true. This flow ends at a CSV on disk at a path the operator chose;
 * contributing to openEQUELLA is a separate flow reached from Choose, with its
 * own typed-count confirmation. Checked rather than assumed -- `extractRun` is
 * the last call on this path.
 */
describe('the model confirmation before a run', () => {
  const withAi: Profile = {
    version: 1,
    pattern: '{part1}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/description', sources: [{ opening: true }, { ai: true }] },
    ],
  };

  const HOSTED = {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    budget: 8000,
    cap: 500,
    timeoutMs: 120_000,
    hasApiKey: true,
  };

  /** A controller sat on the save step with `profile` loaded, ready to save. */
  async function ready(
    a: ReturnType<typeof api>,
    profile: Profile,
    confirm: (text: string) => boolean,
  ): Promise<ReturnType<typeof createExtractController>> {
    const c = createExtractController({
      api: a as never,
      instanceId: 'https://oeq.example.edu',
      confirm,
      onExit: vi.fn(),
      render: vi.fn(),
    });
    await c.chooseFolder();
    await c.continue();
    await c.setTemplate('t');
    await c.continue();
    return c;
  }

  /**
   * THE ZERO-PREREQUISITE PROMISE, at the one place that could break it. A
   * library that never configures an endpoint gets exactly today's behaviour:
   * no dialog, no error, no degraded mode -- and, since `getModel` answered
   * null, nothing to send anything to.
   */
  it('asks nothing and changes nothing when no model is configured', async () => {
    const confirm = vi.fn(() => true);
    const a = api({ loadTemplate: vi.fn(async () => withAi), getModel: vi.fn(async () => null) });
    const c = await ready(a, withAi, confirm);
    await c.save();
    expect(confirm).not.toHaveBeenCalled();
    expect(a.extractRun).toHaveBeenCalled();
    expect(c.state().savedPath).toBe('C:/files/out.csv');
  });

  /** A model configured, but no column asking for one: nothing would be sent,
   *  so there is nothing to confirm. */
  it('asks nothing when no column asked for a model', async () => {
    const confirm = vi.fn(() => true);
    const a = api({ getModel: vi.fn(async () => HOSTED) });
    const c = await ready(a, profile, confirm);
    await c.save();
    expect(confirm).not.toHaveBeenCalled();
    expect(a.extractRun).toHaveBeenCalled();
  });

  it('names the count, the host and the model before running', async () => {
    const confirm = vi.fn((_text: string) => true);
    const a = api({ loadTemplate: vi.fn(async () => withAi), getModel: vi.fn(async () => HOSTED) });
    const c = await ready(a, withAi, confirm);
    await c.save();
    expect(confirm).toHaveBeenCalledTimes(1);
    const text = confirm.mock.calls[0]![0];
    expect(text).toContain('api.openai.com');
    expect(text).toContain('gpt-4o-mini');
    // One supported file, one model column: one request.
    expect(text).toMatch(/up to 1 model requests/);
    expect(a.extractRun).toHaveBeenCalled();
  });

  /** Cancel means cancel: nothing is written, and the operator is left where
   *  they were rather than dropped somewhere with a half-run behind them. */
  it('runs nothing at all when the operator declines', async () => {
    const confirm = vi.fn(() => false);
    const a = api({ loadTemplate: vi.fn(async () => withAi), getModel: vi.fn(async () => HOSTED) });
    const c = await ready(a, withAi, confirm);
    await c.save();
    expect(a.extractRun).not.toHaveBeenCalled();
    expect(c.state().savedPath).toBeNull();
    expect(c.state().step).toBe('save');
  });

  /** Local endpoint: nothing leaves the machine and nothing is billed, so the
   *  dialog is friction that teaches the operator to click past dialogs. */
  it('asks nothing for a model running on this computer, and still runs', async () => {
    const confirm = vi.fn(() => true);
    const a = api({
      loadTemplate: vi.fn(async () => withAi),
      getModel: vi.fn(async () => ({ ...HOSTED, baseUrl: 'http://localhost:11434/v1', model: 'llama3' })),
    });
    const c = await ready(a, withAi, confirm);
    await c.save();
    expect(confirm).not.toHaveBeenCalled();
    expect(a.extractRun).toHaveBeenCalled();
  });

  /**
   * A store that cannot be read is "no model configured", which is the safe
   * answer as well as the honest one: it must never be read as permission to
   * send documents somewhere.
   */
  it('treats an unreadable store as no model, and runs without asking', async () => {
    const confirm = vi.fn(() => true);
    const a = api({
      loadTemplate: vi.fn(async () => withAi),
      getModel: vi.fn(async () => { throw new Error('store unreadable'); }),
    });
    const c = await ready(a, withAi, confirm);
    await c.save();
    expect(confirm).not.toHaveBeenCalled();
    expect(a.extractRun).toHaveBeenCalled();
    expect(c.state().error).toBeNull();
  });

  /** The dialog is shown BEFORE the output path is chosen would be wrong the
   *  other way -- but it must certainly come before anything is read or sent. */
  it('asks before the extract runs, never after', async () => {
    const order: string[] = [];
    const confirm = vi.fn(() => {
      order.push('confirm');
      return true;
    });
    const a = api({
      loadTemplate: vi.fn(async () => withAi),
      getModel: vi.fn(async () => HOSTED),
      extractRun: vi.fn(async () => {
        order.push('run');
        return { outPath: 'C:/files/out.csv', written: 1, flagged: 0 };
      }),
    });
    const c = await ready(a, withAi, confirm);
    await c.save();
    expect(order).toEqual(['confirm', 'run']);
  });
});
