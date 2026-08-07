import { describe, it, expect } from 'vitest';
import { duplicatesSection } from '../../../src/desktop/ui/duplicates.js';
import type { DuplicateFinding } from '../../../src/core/duplicates.js';

const finding = (over: Partial<DuplicateFinding> = {}): DuplicateFinding => ({
  rowNumber: 4,
  fileName: 'Smith_Jane.pdf',
  tier: 'near-certain',
  detail: "an item with this title already holds a file called 'Smith_Jane.pdf'",
  existing: [],
  ...over,
});

describe('duplicatesSection', () => {
  it('renders nothing at all when there are no findings', () => {
    expect(duplicatesSection([], {})).toBe('');
  });

  it('names every flagged row', () => {
    const html = duplicatesSection([finding({ rowNumber: 4 }), finding({ rowNumber: 9 })], {});
    expect(html).toContain('>4<');
    expect(html).toContain('>9<');
    expect(html).toContain('Possible duplicates (2)');
  });

  // Only near-certain defaults to skip. A title-only match defaults to
  // uploading, because two items can share a title and dropping a real item
  // silently is worse than a duplicate the operator can see.
  it('pre-selects Skip for a near-certain row', () => {
    const html = duplicatesSection([finding({ tier: 'near-certain' })], {});
    expect(html).toMatch(/value="skip"[^>]*\schecked/);
    expect(html).not.toMatch(/value="upload"[^>]*\schecked/);
  });

  it('pre-selects Upload for a merely possible row', () => {
    const html = duplicatesSection([finding({ tier: 'possible' })], {});
    expect(html).toMatch(/value="upload"[^>]*\schecked/);
    expect(html).not.toMatch(/value="skip"[^>]*\schecked/);
  });

  it('lets an explicit choice override the tier default', () => {
    const html = duplicatesSection([finding({ rowNumber: 4, tier: 'near-certain' })], { 4: 'upload' });
    expect(html).toMatch(/value="upload"[^>]*\schecked/);
    expect(html).not.toMatch(/value="skip"[^>]*\schecked/);
  });

  it('gives each row its own radio group, so choices do not collide', () => {
    const html = duplicatesSection([finding({ rowNumber: 4 }), finding({ rowNumber: 9 })], {});
    expect(html).toContain('name="dup-4"');
    expect(html).toContain('name="dup-9"');
  });

  /**
   * A filename comes from disk and a detail string quotes it. Neither is
   * trustworthy input for a template that is assigned to innerHTML.
   */
  it('escapes a filename containing markup', () => {
    const html = duplicatesSection([finding({ fileName: '<img src=x onerror=alert(1)>.pdf' })], {});
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('escapes the detail text', () => {
    const html = duplicatesSection([finding({ detail: 'holds <script>bad()</script>' })], {});
    expect(html).not.toContain('<script>');
  });

  /**
   * The tier crosses an IPC boundary. An unrecognised value must not reach
   * escapeHtml as undefined -- that throws inside the render, and a throw
   * inside a render is a blank window with nothing in the terminal.
   */
  it('survives a tier it does not recognise', () => {
    const html = duplicatesSection(
      [finding({ tier: 'something-new' as DuplicateFinding['tier'] })],
      {},
    );
    expect(html).toContain('Possible duplicates (1)');
    expect(html).not.toContain('undefined');
  });

  // The hint tells the operator to check the rest themselves; without this
  // there is nothing to check against.
  it('shows what the existing item already holds', () => {
    const html = duplicatesSection(
      [finding({ existing: [{ uuid: 'u', version: 1, title: 'T', attachmentNames: ['Lee_Anna.pdf'] }] })],
      {},
    );
    expect(html).toContain('Lee_Anna.pdf');
  });

  it('escapes those filenames too', () => {
    const html = duplicatesSection(
      [finding({ existing: [{ uuid: 'u', version: 1, title: 'T', attachmentNames: ['<b>x</b>.pdf'] }] })],
      {},
    );
    expect(html).not.toContain('<b>x</b>');
  });

  it('caps how many it lists, so one item with many attachments cannot flood the table', () => {
    const many = Array.from({ length: 10 }, (_, i) => `f${i}.pdf`);
    const html = duplicatesSection(
      [finding({ existing: [{ uuid: 'u', version: 1, title: 'T', attachmentNames: many }] })],
      {},
    );
    expect(html).toContain('f0.pdf');
    expect(html).not.toContain('f9.pdf');
  });

  it('says nothing about held files when the existing item has none', () => {
    expect(duplicatesSection([finding({ existing: [] })], {})).not.toContain('Existing item holds');
  });
});
