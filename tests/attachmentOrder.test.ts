import { describe, it, expect } from 'vitest';
import {
  canWriteInOrder,
  formatAttachmentOrder,
  parseAttachmentOrder,
} from '../src/core/attachmentOrder.js';

describe('the attachment order cell', () => {
  // THE ROUND TRIP is the property that matters: what the extractor writes is
  // what plan reads back, for every name canWriteInOrder lets through.
  it.each([
    [['No1.pdf', 'No2.pdf']],
    [['SRE_1972-73_Vol2_No3.pdf', 'Commemorative issue.pdf', 'No2&3.pdf']],
    [['one.pdf']],
  ])('reads back exactly what it wrote: %j', (names) => {
    expect(names.every(canWriteInOrder)).toBe(true);
    expect(parseAttachmentOrder(formatAttachmentOrder(names))).toEqual(names);
  });

  it('refuses the names a round trip would change', () => {
    expect(canWriteInOrder('Vol 3; No 2.pdf')).toBe(false);
    expect(canWriteInOrder(' cover.pdf')).toBe(false);
    expect(canWriteInOrder('cover.pdf ')).toBe(false);
  });

  it('reads a blank cell as no order', () => {
    expect(parseAttachmentOrder('')).toEqual([]);
    expect(parseAttachmentOrder(' ; ')).toEqual([]);
  });
});
