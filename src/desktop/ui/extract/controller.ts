// src/desktop/ui/extract/controller.ts
import type { OeqApi } from '../../ipc.js';
import { addColumn, removeColumn, moveColumn, setSources, setDefault } from '../../../core/extract/columns.js';
import type { Profile, Source } from '../../../core/extract/types.js';
import { stripElectronWrapper } from '../errors.js';
import { initialExtractState, canContinue, type ExtractState } from './state.js';

export interface ExtractControllerOptions {
  api: OeqApi;
  /** Called when the operator leaves the flow. */
  onExit(): void;
  /** Called after every state change; the caller decides which screen to draw. */
  render(state: ExtractState): void;
}

export interface ExtractController {
  state(): ExtractState;
  chooseFolder(): Promise<void>;
  continue(): Promise<void>;
  back(): void;
  setPattern(pattern: string): Promise<void>;
  addColumn(path: string): Promise<void>;
  removeColumn(path: string): Promise<void>;
  moveColumn(path: string, delta: number): Promise<void>;
  setSource(path: string, source: Source | null): Promise<void>;
  setDefault(path: string, value: string): Promise<void>;
  openProfile(): Promise<void>;
  saveProfile(): Promise<void>;
  save(): Promise<void>;
  undoRemove(): Promise<void>;
  openAdd(): void;
  setAddQuery(query: string): void;
  closeAdd(): void;
  exit(): void;
}

export function createExtractController(options: ExtractControllerOptions): ExtractController {
  let state = initialExtractState();

  const set = (patch: Partial<ExtractState>): void => {
    state = { ...state, ...patch };
    options.render(state);
  };

  /**
   * Every IPC call goes through here. Electron wraps errors crossing IPC as
   * "Error invoking remote method '<channel>': <Class>: <real message>";
   * stripElectronWrapper removes that so the operator sees the real message.
   */
  const guard = async (work: () => Promise<Partial<ExtractState>>): Promise<void> => {
    set({ busy: true, error: null });
    try {
      set({ ...(await work()), busy: false });
    } catch (error) {
      set({ busy: false, error: stripElectronWrapper((error as Error).message) });
    }
  };

  const refreshPreview = async (profile: Profile): Promise<Partial<ExtractState>> => {
    if (state.dir === null) return { profile };
    return { profile, preview: await options.api.extractPreview({ dir: state.dir, profile }) };
  };

  /** Apply a pure column operation, then refresh the preview from the result. */
  const edit = (fn: (p: Profile) => Profile) => async (): Promise<void> => {
    if (state.profile === null) return;
    await guard(async () => ({ ...(await refreshPreview(fn(state.profile!))), removed: null }));
  };

  return {
    state: () => state,

    async chooseFolder() {
      const dir = await options.api.chooseFolder();
      if (dir === null) return;
      await guard(async () => {
        const scan = await options.api.extractScan(dir);
        const schemaPaths = await options.api.schemaPaths();
        // The starter profile is built in the main process and arrives with the
        // scan. It holds only the attachment column: the program can see a
        // filename has four parts but cannot know part 2 is a first name.
        //
        // It is NOT computed here. `core/extract/suggest.ts` reaches
        // `node:path` and, through the readers, `node:fs/promises` -- and this
        // module runs in a sandboxed renderer with no Node access. Importing it
        // killed the entire module graph and the window rendered blank, with
        // nothing on the terminal. Guarded by tests/desktop/rendererPurity.test.ts.
        const profile = state.profile ?? scan.starter;
        return { dir, scan, schemaPaths, profile };
      });
    },

    async continue() {
      if (!canContinue(state)) return;
      if (state.step === 'folder' && state.profile !== null) {
        await guard(async () => ({ step: 'columns' as const, ...(await refreshPreview(state.profile!)) }));
        return;
      }
      if (state.step === 'columns') set({ step: 'save' });
    },

    back() {
      if (state.step === 'save') set({ step: 'columns', error: null });
      else if (state.step === 'columns') set({ step: 'folder', error: null });
      else options.onExit();
    },

    async setPattern(pattern) {
      await edit((p) => ({ ...p, pattern }))();
    },

    async addColumn(path) {
      await edit((p) => addColumn(p, path))();
      set({ adding: false, addQuery: '' });
    },
    async removeColumn(path) {
      if (state.profile === null) return;
      const index = state.profile.columns.findIndex((c) => c.path === path);
      const column = state.profile.columns[index];
      await guard(async () => {
        // removeColumn throws for the locked attachment column. Computing the
        // next state BEFORE recording the undo means a refused removal leaves
        // no undo behind, which would otherwise offer to restore a column
        // that was never taken away.
        const next = removeColumn(state.profile!, path);
        return {
          ...(await refreshPreview(next)),
          removed: column === undefined ? null : { column, index },
        };
      });
    },
    async moveColumn(path, delta) {
      await edit((p) => moveColumn(p, path, delta))();
    },
    async setSource(path, source) {
      await edit((p) => setSources(p, path, source === null ? [] : [source]))();
    },
    async setDefault(path, value) {
      await edit((p) => setDefault(p, path, value))();
    },

    async openProfile() {
      const opened = await options.api.openProfile();
      if (opened === null) return;
      await guard(async () => ({
        profilePath: opened.path,
        ...(await refreshPreview(opened.profile)),
      }));
    },

    async saveProfile() {
      if (state.profile === null) return;
      await guard(async () => {
        const path = await options.api.saveProfileAs(state.profile!);
        return path === null ? {} : { profilePath: path };
      });
    },

    async save() {
      if (state.dir === null || state.profile === null) return;
      const outPath = await options.api.chooseCsvPath();
      if (outPath === null) return;
      await guard(async () => {
        const report = await options.api.extractRun({ dir: state.dir!, profile: state.profile!, outPath });
        return { savedPath: report.outPath, savedFlagged: report.flagged };
      });
    },

    async undoRemove() {
      const pending = state.removed;
      if (pending === null || state.profile === null) return;
      await guard(async () => {
        const columns = [...state.profile!.columns];
        // Spliced back at its original index: the order IS the spreadsheet's
        // column order, so an undo that appends is not an undo.
        columns.splice(Math.min(pending.index, columns.length), 0, pending.column);
        return { ...(await refreshPreview({ ...state.profile!, columns })), removed: null };
      });
    },

    openAdd: () => set({ adding: true, addQuery: '' }),
    setAddQuery: (addQuery) => set({ addQuery }),
    closeAdd: () => set({ adding: false, addQuery: '' }),

    exit: options.onExit,
  };
}
