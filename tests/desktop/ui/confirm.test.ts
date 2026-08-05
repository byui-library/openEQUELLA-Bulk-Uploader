import { describe, it, expect } from 'vitest';
import { canUpload } from '../../../src/desktop/ui/confirm.js';

describe('canUpload -- the publish safety gate', () => {
  describe('draft (the default, no typed confirmation required)', () => {
    it('is enabled with an empty typed count', () => {
      expect(canUpload('draft', 12, '')).toBe(true);
    });

    it('is disabled when there is nothing to upload', () => {
      expect(canUpload('draft', 0, '')).toBe(false);
    });
  });

  describe('published (requires the typed count to match exactly)', () => {
    it('is disabled with an empty typed field', () => {
      expect(canUpload('published', 12, '')).toBe(false);
    });

    it('is disabled with a whitespace-only typed field', () => {
      expect(canUpload('published', 12, '   ')).toBe(false);
    });

    it('is disabled when the typed count does not match (too low)', () => {
      expect(canUpload('published', 12, '11')).toBe(false);
    });

    it('is disabled when the typed count does not match (too high)', () => {
      expect(canUpload('published', 12, '13')).toBe(false);
    });

    it('is disabled for a non-numeric entry', () => {
      expect(canUpload('published', 12, 'twelve')).toBe(false);
    });

    it('is disabled for a numeric-looking entry with trailing junk', () => {
      expect(canUpload('published', 12, '12x')).toBe(false);
    });

    it('is disabled for a decimal', () => {
      expect(canUpload('published', 12, '12.0')).toBe(false);
    });

    it('is disabled for a signed number', () => {
      expect(canUpload('published', 12, '+12')).toBe(false);
    });

    it('is disabled for scientific notation that happens to evaluate equal', () => {
      expect(canUpload('published', 100, '1e2')).toBe(false);
    });

    it('is enabled once the exact count is typed', () => {
      expect(canUpload('published', 12, '12')).toBe(true);
    });

    it('tolerates surrounding whitespace around a correct count', () => {
      expect(canUpload('published', 12, '  12  ')).toBe(true);
      expect(canUpload('published', 12, '\n12\n')).toBe(true);
    });

    it('is disabled when there is nothing to upload, even with "0" typed', () => {
      expect(canUpload('published', 0, '0')).toBe(false);
    });
  });
});
