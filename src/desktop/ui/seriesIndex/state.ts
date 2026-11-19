// src/desktop/ui/seriesIndex/state.ts
import type { IndexPreview, IndexSourceArgs } from '../../ipc.js';
import type { TemplateSummary } from '../../../core/extract/templates.js';
import { plural } from '../../../core/seriesIndex/words.js';

export interface IndexFlowState {
  /** Where the index is built from: a search of a collection, or batch records. Fixed for the flow. */
  source: IndexSourceArgs;
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

export function initialIndexState(source: IndexSourceArgs = { collectionUuid: '' }): IndexFlowState {
  return {
    source,
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

/** Which source the flow reads, in the operator's words. */
export function sourceHint(source: IndexSourceArgs): string {
  if (!('recordPaths' in source)) return 'From a search of this collection.';
  const n = source.recordPaths.length;
  return `From ${n === 1 ? 'a batch record' : plural(n, 'batch record', 'batch records')}.`;
}

/** Build is offered only when every chosen destination can actually be used. */
export function canBuild(s: IndexFlowState): boolean {
  if (s.working || s.preview === null || s.preview.volumes.length === 0) return false;
  if (!s.saveFiles && !s.upload && !(s.linkVolumes && canLinkVolumes(s))) return false;
  if (s.saveFiles && s.folder === null) return false;
  if (s.upload && (s.preview.existing.kind === 'many' || s.preview.existing.kind === 'unavailable')) return false;
  return true;
}
