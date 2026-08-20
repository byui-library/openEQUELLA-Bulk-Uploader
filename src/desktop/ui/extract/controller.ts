// src/desktop/ui/extract/controller.ts
import type { OeqApi } from '../../ipc.js';
import { addColumn, removeColumn, moveColumn, setFirstSource, setDefault } from '../../../core/extract/columns.js';
import type { Profile, Source } from '../../../core/extract/types.js';
import { errorMessage } from '../errors.js';
import { aiConfirmation } from '../../../core/ai/confirm.js';
import { initialExtractState, canContinue, type ExtractState } from './state.js';
import type { ModelProgress } from '../../../core/ai/fill.js';
import { plainLabel } from './picker.js';

export interface ExtractControllerOptions {
  api: OeqApi;
  /**
   * Whose schema the columns are validated against, or '' for none.
   *
   * Extraction NEVER touches the network -- that is what lets an operator
   * build a spreadsheet without signing in to anything -- so this does not
   * fetch a schema. It names the instance whose already-fetched schema is in
   * the on-disk cache (core/schemaCache.ts). With no id, or no cache for it,
   * the main process falls back to the schema export bundled with the app;
   * extraction runs either way (ipc.ts's schemaPaths).
   */
  instanceId?: string;
  /**
   * Ask the operator to approve something, and answer whether they did.
   *
   * INJECTED so `save()` can be tested without a DOM -- this project has no
   * jsdom, deliberately -- and defaulted to `window.confirm`, which is the
   * pattern app.ts's "Clear all credentials…" already uses for a click that cannot
   * be undone.
   *
   * NOT THE PUBLISH GATE, and the difference is deliberate. Confirm's typed
   * item count exists because publishing puts real items into a live collection
   * with no moderation queue -- there is nothing to undo. This step writes a
   * CSV to a path the operator picks; the recovery is to not use the file. What
   * it costs is money and text leaving the machine, which is what the dialog
   * states, and a run on a local model is not made to click through anything
   * at all (core/ai/confirm.ts).
   */
  confirm?: (text: string) => boolean;
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
  setTemplate(id: string): Promise<void>;
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

  // Fetched once, when the flow starts, rather than lazily when the folder
  // screen first draws -- the "start from" select needs the list ready by
  // the time the operator has picked a folder. A rejection (e.g. no
  // templates directory bundled, or a packaged build that doesn't ship one)
  // must not stop a generic extraction, so it is swallowed here rather than
  // surfaced through `guard`: no templates offered is just the empty list.
  void options.api.listTemplates().then(
    (templates) => set({ templates }),
    () => {},
  );

  /**
   * Every IPC call goes through here. Electron wraps errors crossing IPC as
   * "Error invoking remote method '<channel>': <Class>: <real message>";
   * stripElectronWrapper removes that so the operator sees the real message.
   */
  /**
   * Turn one model-pass event into the line the operator reads.
   *
   * `asking` is the one that has to be live: it is what explains a wait. The
   * outcomes are already recorded in `_notes` and counted on the save screen,
   * so they scroll past here rather than being the point.
   */
  function describeModelEvent(event: ModelProgress): string {
    const field = plainLabel(event.path);
    if (event.stage === 'asking') return `Asking the model about ${field} for ${event.file}…`;
    if (event.stage === 'written') return `The model wrote ${field} for ${event.file}.`;
    if (event.stage === 'refused')
      return `Refused the model's ${field} for ${event.file} — the document does not support it.`;
    if (event.stage === 'discarded') return `Discarded the model's ${field} for ${event.file}.`;
    if (event.stage === 'failed') return `The model could not be reached for ${event.file}.`;
    return `Skipped ${field} for ${event.file}.`;
  }

  // REGISTERED ONCE, not per run: preload's `onModelProgress` adds a new
  // ipcRenderer listener on every call, so registering it inside `save()`
  // would fire the handler once per save the operator had ever done.
  options.api.onModelProgress((event) => {
    set({ modelStatus: describeModelEvent(event) });
  });

  const guard = async (work: () => Promise<Partial<ExtractState>>): Promise<void> => {
    set({ busy: true, error: null });
    try {
      set({ ...(await work()), busy: false });
    } catch (error) {
      // errorMessage, not stripElectronWrapper directly: it handles a thrown
      // value that is not an Error, where `(error as Error).message` would be
      // undefined and blank the error line instead of showing anything. Every
      // other catch site in the desktop app uses it.
      set({ busy: false, error: errorMessage(error) });
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

  /**
   * The two separate answers a confirmation produces.
   *
   * THEY ARE NOT THE SAME QUESTION, and collapsing them to one boolean is what
   * let an unreadable settings store turn into an unannounced hosted send.
   * "Build the spreadsheet" and "send documents to a model" have different
   * defaults: the first should proceed through almost anything, because
   * extraction works offline and has no prerequisites; the second must not
   * happen unless somebody said so.
   */
  interface ModelApproval {
    /** Whether to run the extract at all. False only on a real refusal. */
    proceed: boolean;
    /** Whether the operator agreed to documents leaving this machine. Carried to
     *  `extractRun`, which sends only on a true. */
    sendToModel: boolean;
  }

  /**
   * Whether this run may go ahead, having told the operator what it will send.
   *
   * TRUE IS THE ANSWER IN EVERY CASE BUT ONE -- a real refusal of a real
   * dialog. `aiConfirmation` returns null for every state in which nothing
   * would be sent (no endpoint stored, no column asking for one, no documents,
   * a cap of zero) and for an endpoint on this machine, and a null is not a
   * question to be answered.
   *
   * A STORE THAT CANNOT BE READ IS "NO MODEL", never a reason to stop the
   * extract. Extraction works offline and without any of this; refusing to
   * build a spreadsheet because a settings file would not decrypt would break
   * the half of the tool that has no prerequisites, over a feature the operator
   * may never have configured.
   */
  async function approveModelRun(profile: Profile): Promise<ModelApproval> {
    let model: Awaited<ReturnType<OeqApi['getModel']>> = null;
    try {
      model = await options.api.getModel(options.instanceId ?? '');
    } catch {
      // AN UNREADABLE STORE IS NOT PERMISSION TO SEND. It used to answer "carry
      // on" -- which was right about the extract and wrong about the model,
      // because the main process then made its OWN read of the same store,
      // possibly succeeded, and sent a whole batch to a hosted endpoint with no
      // dialog ever shown. `sendToModel: false` is now carried to the run, so a
      // read this side could not make cannot be overruled by a read the other
      // side could.
      return { proceed: true, sendToModel: false };
    }
    if (model === null) return { proceed: true, sendToModel: false };

    // NO SCAN IS NOT AN EMPTY FOLDER. `aiConfirmation` returns null for zero
    // documents -- correctly, since a dialog offering to send nothing teaches
    // the operator that this dialog means nothing -- and null is an approval. So
    // folding "we do not know how many files there are" into the same zero would
    // make a missing count read as consent to a run of unknown size. Unreachable
    // today, because `chooseFolder` sets `dir` and `scan` together and `save()`
    // requires `dir`; it is a fragile way to gate consent all the same.
    if (state.scan === null) return { proceed: true, sendToModel: false };

    const text = aiConfirmation({
      profile,
      // The whole folder, not the preview: the run reads every file fresh
      // (extractHandlers.ts), so the preview's five rows would understate the
      // count by two orders of magnitude on a real batch.
      documents: state.scan.supported.length,
      model: model.model,
      baseUrl: model.baseUrl,
      budget: model.budget,
      cap: model.cap,
    });
    // No dialog warranted -- a loopback endpoint, no column asking, no
    // documents, a cap of zero. Not a question, and for the loopback case the
    // model genuinely does run, so this is an approval and not a refusal.
    if (text === null) return { proceed: true, sendToModel: true };

    const agreed = (options.confirm ?? ((message: string) => window.confirm(message)))(text);
    return { proceed: agreed, sendToModel: agreed };
  }

  return {
    state: () => state,

    async chooseFolder() {
      const dir = await options.api.chooseFolder();
      if (dir === null) return;
      await guard(async () => {
        // Independent of each other: one samples the chosen folder, the others
        // read a schema (the site's own from the cache, or the bundled export).
        // Run together, as app.ts already does for its own pair of unrelated
        // calls. All three take the same instance id so the scan's starter
        // profile and the Add-column picker cannot disagree about which columns
        // are valid.
        const instanceId = options.instanceId ?? '';
        const [scan, schemaPaths, schemaNamePath] = await Promise.all([
          options.api.extractScan(dir, instanceId),
          options.api.schemaPaths(instanceId),
          options.api.schemaNamePath(instanceId),
        ]);
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
        return { dir, scan, schemaPaths, schemaNamePath, profile };
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
      // The screen shows ONE source per column, so this governs position 0 and
      // leaves the rest of the chain alone. It used to write `[source]`, which
      // deleted every later tier -- see `setFirstSource`.
      await edit((p) => setFirstSource(p, path, source))();
    },
    async setDefault(path, value) {
      await edit((p) => setDefault(p, path, value))();
    },

    async setTemplate(id) {
      if (id === '') {
        // Generic: back to whatever the scan proposed, exactly as it was --
        // not a fresh re-scan, which could reorder or re-guess columns the
        // operator has not touched yet.
        set({ templateId: id, profile: state.scan?.starter ?? state.profile });
        return;
      }
      await guard(async () => ({ templateId: id, profile: await options.api.loadTemplate(id) }));
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
      // LAST THING BEFORE THE RUN, and after the file picker on purpose:
      // approving a send and then cancelling the save dialog left an approval
      // standing for a run that never happened. A confirmation should be the
      // step immediately before the thing it confirms, with nothing that can
      // still call the whole thing off in between.
      const approval = await approveModelRun(state.profile);
      if (!approval.proceed) return;
      // Cleared before the run so a line left over from a previous save is
      // never read as this one's progress.
      set({ modelStatus: null });
      await guard(async () => {
        const report = await options.api.extractRun({
          dir: state.dir!,
          profile: state.profile!,
          outPath,
          // THE SAME ID `approveModelRun` JUST READ THE ENDPOINT FROM. The run
          // resolves its own settings in the main process, where the API key
          // lives; passing the id is what makes the two reads land on one
          // per-instance entry. Send a different id -- or none -- and the
          // operator is shown one endpoint and their documents go to another,
          // or to none at all after they agreed to a send.
          instanceId: options.instanceId ?? '',
          // The consent, carried rather than re-derived. See `ModelApproval`.
          modelApproved: approval.sendToModel,
        });
        return {
          savedPath: report.outPath,
          savedWritten: report.written,
          savedFlagged: report.flagged,
          savedAiWritten: report.aiWritten,
        };
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
