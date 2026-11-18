// src/desktop/ui/seriesIndex/controller.ts
import type { OeqApi } from '../../ipc.js';
import { errorMessage } from '../errors.js';
import { canBuild, initialIndexState, type IndexFlowState } from './state.js';

/**
 * The "Build an index" flow. Owns its state and render loop, as the extract
 * flow does; app.ts hands over the root element and gets it back on exit.
 *
 * Two confirmations, both naming what will happen: replacing files that are
 * already in the folder, and PUBLISHING a new item (the collection may have no
 * moderation queue). An update keeps the item's state and asks nothing more.
 */
export interface IndexControllerOptions {
  api: OeqApi;
  instanceId: string;
  collectionUuid: string;
  confirm?: (text: string) => boolean;
  onExit(): void;
  render(state: IndexFlowState): void;
}

export function createIndexController(options: IndexControllerOptions) {
  let state = initialIndexState();
  const confirm = options.confirm ?? ((text: string) => window.confirm(text));
  // Once the operator has left, nothing in flight may draw over what app.ts drew.
  let exited = false;
  // Only the newest preview request may apply its result.
  let previewRequest = 0;
  const set = (patch: Partial<IndexFlowState>) => {
    state = { ...state, ...patch };
    if (!exited) options.render(state);
  };

  return {
    state: () => state,

    async start(): Promise<void> {
      try {
        set({ templates: await options.api.indexTemplates() });
      } catch (err) {
        set({ templates: [], error: errorMessage(err) });
      }
    },

    async setTemplate(id: string): Promise<void> {
      const mine = ++previewRequest;
      set({ templateId: id, loading: true, preview: null, done: [], error: null });
      try {
        const preview = await options.api.indexPreview({
          instanceId: options.instanceId,
          collectionUuid: options.collectionUuid,
          templateId: id,
        });
        if (mine !== previewRequest) return;
        set({ preview, loading: false });
      } catch (err) {
        if (mine !== previewRequest) return;
        set({ loading: false, error: errorMessage(err) });
      }
    },

    setSaveFiles(on: boolean): void {
      set({ saveFiles: on });
    },
    setUpload(on: boolean): void {
      set({ upload: on });
    },
    setDraft(draft: boolean): void {
      set({ draft });
    },

    async chooseFolder(): Promise<void> {
      const folder = await options.api.chooseFolder();
      if (folder !== null) set({ folder });
    },

    async build(): Promise<void> {
      if (!canBuild(state) || state.preview === null) return;
      const { buildId, existing } = state.preview;
      const done: string[] = [];
      set({ working: true, error: null, done });
      try {
        if (state.saveFiles && state.folder !== null) {
          let saved = await options.api.indexSaveFiles({ buildId, dir: state.folder, replace: false });
          if (saved.kind === 'exists') {
            const ok = confirm(`${saved.names.join(', ')} already exist in ${state.folder}. Replace them?`);
            saved = ok ? await options.api.indexSaveFiles({ buildId, dir: state.folder, replace: true }) : saved;
          }
          done.push(saved.kind === 'saved' ? `Saved ${saved.paths.join(', ')}` : 'Files not saved: you kept the ones already there.');
        }
        let preview = state.preview;
        if (state.upload) {
          const publishing = existing.kind === 'none' && !state.draft;
          if (publishing && !confirm('Publish the new index item? It will be live in the collection straight away.')) {
            done.push('Not uploaded: you chose not to publish.');
          } else {
            const up = await options.api.indexUpload({ buildId, draft: state.draft });
            done.push(`${up.kind === 'created' ? 'Created' : 'Updated'} the index item: ${up.url}`);
            // The main side now treats the item as existing; so must the screen,
            // or a second click would offer Draft/Publish for an item that is there.
            if (existing.kind === 'none') {
              preview = { ...preview, existing: { kind: 'one', status: state.draft ? 'draft' : 'live' } };
            }
          }
        }
        set({ working: false, done: [...done], preview });
      } catch (err) {
        set({ working: false, done: [...done], error: errorMessage(err) });
      }
    },

    exit(): void {
      exited = true;
      options.onExit();
    },
  };
}

export type IndexController = ReturnType<typeof createIndexController>;
