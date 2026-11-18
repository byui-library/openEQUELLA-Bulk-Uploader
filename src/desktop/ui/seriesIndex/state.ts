// src/desktop/ui/seriesIndex/state.ts
import type { IndexPreview } from '../../ipc.js';
import type { TemplateSummary } from '../../../core/extract/templates.js';

export interface IndexFlowState {
  templates: TemplateSummary[] | null;
  templateId: string | null;
  loading: boolean;
  preview: IndexPreview | null;
  saveFiles: boolean;
  folder: string | null;
  upload: boolean;
  draft: boolean;
  working: boolean;
  done: string[];
  error: string | null;
}

export function initialIndexState(): IndexFlowState {
  return {
    templates: null,
    templateId: null,
    loading: false,
    preview: null,
    saveFiles: false,
    folder: null,
    upload: false,
    draft: true,
    working: false,
    done: [],
    error: null,
  };
}

/** Build is offered only when every chosen destination can actually be used. */
export function canBuild(s: IndexFlowState): boolean {
  if (s.working || s.preview === null || s.preview.volumes.length === 0) return false;
  if (!s.saveFiles && !s.upload) return false;
  if (s.saveFiles && s.folder === null) return false;
  if (s.upload && (s.preview.existing.kind === 'many' || s.preview.existing.kind === 'unavailable')) return false;
  return true;
}
