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
  /** Add a link to the index as every listed volume's first attachment. */
  linkVolumes: boolean;
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
    linkVolumes: false,
    working: false,
    done: [],
    error: null,
  };
}

/**
 * The volume links are offered only when there is an index item to point at:
 * one that exists, or a new one this same build uploads first.
 */
export function canLinkVolumes(s: IndexFlowState): boolean {
  const e = s.preview?.existing;
  return e !== undefined && (e.kind === 'one' || (e.kind === 'none' && s.upload));
}

/** Build is offered only when every chosen destination can actually be used. */
export function canBuild(s: IndexFlowState): boolean {
  if (s.working || s.preview === null || s.preview.volumes.length === 0) return false;
  if (!s.saveFiles && !s.upload && !(s.linkVolumes && canLinkVolumes(s))) return false;
  if (s.saveFiles && s.folder === null) return false;
  if (s.upload && (s.preview.existing.kind === 'many' || s.preview.existing.kind === 'unavailable')) return false;
  return true;
}
