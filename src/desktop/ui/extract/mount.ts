import { renderExtractFolder } from '../screens/extractFolder.js';
import { renderExtractColumns } from '../screens/extractColumns.js';
import { renderExtractSave } from '../screens/extractSave.js';
import { renderExtractAddColumn } from '../screens/extractAddColumn.js';
import { describeFilename } from './segments.js';
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

/** The example the columns screen shows, and how many names do NOT fit. */
export interface NameFit {
  /** The first name that FITS the pattern, or the first of all when none does. */
  sample: string;
  /** Names the pattern does not fit: their rows get no parts. */
  unmatched: number;
}

/**
 * The columns screen's example, and the count of names left out.
 *
 * NOT SIMPLY THE FIRST NAME. An index folder sorts ahead of 38 volume folders
 * (operator, 2026-11-17), and showing its parts -- none -- hid the very parts
 * the operator was trying to use. But a matching example alone would hide a
 * pattern that fits one name in three hundred, which is why the count comes
 * with it and the screen states it. Pure, and cheap at a batch's size: a few
 * hundred names checked against one pattern.
 */
export function nameFit(pattern: string, names: readonly string[]): NameFit {
  const matched = names.filter((name) => describeFilename(pattern, name).matched);
  return { sample: matched[0] ?? names[0] ?? '', unmatched: names.length - matched.length };
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
      schemaNamePath: state.schemaNamePath,
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
        templates: state.templates,
        templateId: state.templateId,
        perFolder: state.perFolder,
        onChooseFolder: () => void controller.chooseFolder(),
        onTemplateChange: (id) => void controller.setTemplate(id),
        onPerFolderChange: (on) => void controller.setPerFolder(on),
        onContinue: () => void controller.continue(),
        onCancel: () => controller.exit(),
      });
      return;

    case 'columns': {
      const names = state.scan?.supported ?? [];
      const fit = nameFit(state.profile!.pattern, names);
      renderExtractColumns(root, {
        profile: state.profile!,
        profilePath: state.profilePath,
        sampleFilename: fit.sample,
        unmatchedNames: fit.unmatched,
        nameCount: names.length,
        perFolder: state.perFolder,
        scan: state.scan ?? { labels: [], properties: [], tableColumns: [], sections: [] },
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
    }

    case 'save':
      renderExtractSave(root, {
        fileCount: state.savedPath === null ? (state.scan?.supported.length ?? 0) : state.savedWritten,
        flagged: state.savedFlagged,
        aiWritten: state.savedAiWritten,
        problems: state.savedProblems,
        savedPath: state.savedPath,
        busy: state.busy,
        modelStatus: state.modelStatus,
        error: state.error,
        onSave: () => void controller.save(),
        onBack: () => controller.back(),
        onOpenFolder: () => {
          if (state.savedPath !== null) onOpenFolder(state.savedPath);
        },
        // Shown in Explorer with the log selected, the same way as the
        // spreadsheet -- not opened, so Excel does not launch behind the app.
        onOpenProblems: () => {
          if (state.savedProblems !== null) onOpenFolder(state.savedProblems.path);
        },
        onDone: () => controller.exit(),
      });
  }
}
