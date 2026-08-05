import { renderExtractFolder } from '../screens/extractFolder.js';
import { renderExtractColumns } from '../screens/extractColumns.js';
import { renderExtractSave } from '../screens/extractSave.js';
import { renderExtractAddColumn } from '../screens/extractAddColumn.js';
import { canContinue, type ExtractState } from './state.js';
import type { ExtractController } from './controller.js';

/**
 * Which screen a state draws. Guards the invariant the screens rely on: the
 * columns and save screens require a profile, and rendering them without one
 * would throw inside the renderer, where there is no stack to read.
 */
export function screenFor(state: ExtractState): 'folder' | 'columns' | 'save' {
  if (state.step !== 'folder' && state.profile === null) return 'folder';
  return state.step;
}

export function renderExtract(
  root: HTMLElement,
  state: ExtractState,
  controller: ExtractController,
  onOpenFolder: (path: string) => void,
): void {
  if (state.adding && state.profile !== null) {
    renderExtractAddColumn(root, {
      schemaPaths: state.schemaPaths,
      usedPaths: state.profile.columns.map((c) => c.path),
      query: state.addQuery,
      onQueryChange: (q) => controller.setAddQuery(q),
      onPick: (path) => void controller.addColumn(path),
      onCancel: () => controller.closeAdd(),
    });
    return;
  }

  switch (screenFor(state)) {
    case 'folder':
      renderExtractFolder(root, {
        dir: state.dir,
        scan: state.scan,
        busy: state.busy,
        error: state.error,
        canContinue: canContinue(state),
        onChooseFolder: () => void controller.chooseFolder(),
        onContinue: () => void controller.continue(),
        onCancel: () => controller.exit(),
      });
      return;

    case 'columns':
      renderExtractColumns(root, {
        profile: state.profile!,
        profilePath: state.profilePath,
        sampleFilename: state.scan?.supported[0] ?? '',
        scan: state.scan ?? { labels: [], properties: [] },
        preview: state.preview,
        busy: state.busy,
        error: state.error,
        onPatternChange: (p) => void controller.setPattern(p),
        onSourceChange: (path, source) => void controller.setSource(path, source),
        onDefaultChange: (path, v) => void controller.setDefault(path, v),
        onRemove: (path) => void controller.removeColumn(path),
        onMove: (path, d) => void controller.moveColumn(path, d),
        onAdd: () => controller.openAdd(),
        removed: state.removed === null ? null : { path: state.removed.column.path },
        onUndoRemove: () => void controller.undoRemove(),
        onOpenProfile: () => void controller.openProfile(),
        onSaveProfile: () => void controller.saveProfile(),
        onContinue: () => void controller.continue(),
        onBack: () => controller.back(),
      });
      return;

    case 'save':
      renderExtractSave(root, {
        fileCount: state.savedPath === null ? (state.scan?.supported.length ?? 0) : state.savedWritten,
        flagged: state.savedFlagged,
        savedPath: state.savedPath,
        busy: state.busy,
        error: state.error,
        onSave: () => void controller.save(),
        onBack: () => controller.back(),
        onOpenFolder: () => {
          if (state.savedPath !== null) onOpenFolder(state.savedPath);
        },
        onDone: () => controller.exit(),
      });
  }
}
