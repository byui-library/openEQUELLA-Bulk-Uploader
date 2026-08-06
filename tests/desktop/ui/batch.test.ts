// tests/desktop/ui/batch.test.ts
import { describe, it, expect } from 'vitest';
import { clearedForNextBatch } from '../../../src/desktop/ui/batch.js';

/**
 * What a second batch must NOT inherit from the first.
 *
 * The operator finished a real run and found no way back to Choose, so every
 * additional spreadsheet meant restarting the app. Going back is only safe if
 * the previous batch's selections and results are actually cleared -- a stale
 * sheet path or a stale plan would otherwise be uploaded a second time.
 */
describe('clearedForNextBatch', () => {
  it('forgets the spreadsheet and folder that were just uploaded', () => {
    const next = clearedForNextBatch();
    expect(next.sheetPath).toBeNull();
    expect(next.folderPath).toBeNull();
  });

  it('forgets the plan and the column review it was checked against', () => {
    const next = clearedForNextBatch();
    expect(next.reviewPlan).toBeNull();
    expect(next.reviewColumns).toBeNull();
    expect(next.reviewOverrides).toEqual({});
    expect(next.reviewChecked).toBe(false);
  });

  it('forgets the finished run, so Done cannot be shown again with old counts', () => {
    const next = clearedForNextBatch();
    expect(next.runReport).toBeNull();
    expect(next.interruptedEntries).toEqual([]);
    expect(next.progress).toBeNull();
    expect(next.progressLog).toEqual([]);
  });

  /**
   * Draft, every time. The target collection has NO moderation workflow, so a
   * published item is live immediately with no queue to catch a mistake. An
   * operator who deliberately chose "live" for one batch must choose it again
   * for the next, rather than inheriting it invisibly.
   */
  it('returns the item state to draft rather than inheriting the last choice', () => {
    expect(clearedForNextBatch().itemState).toBe('draft');
  });

  it('clears the typed confirmation count', () => {
    expect(clearedForNextBatch().typedCount).toBe('');
  });

  it('clears every error left over from the last batch', () => {
    const next = clearedForNextBatch();
    expect(next.chooseError).toBeNull();
    expect(next.reviewError).toBeNull();
    expect(next.confirmError).toBeNull();
    expect(next.resultsError).toBeNull();
  });

  // The collection is deliberately absent: it stays selected, is shown on the
  // Choose screen, and is nearly always the same for the next batch.
  it('says nothing about the collection or the signed-in user', () => {
    const keys = Object.keys(clearedForNextBatch());
    expect(keys).not.toContain('collectionUuid');
    expect(keys).not.toContain('user');
    expect(keys).not.toContain('instanceId');
  });
});
