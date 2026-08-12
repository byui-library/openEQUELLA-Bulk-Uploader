import { describe, it, expect } from 'vitest';
import * as types from '../src/core/types.js';
import { ATTACHMENT_COLUMN } from '../src/core/types.js';

describe('scaffold', () => {
  it('exposes the reserved column constant', () => {
    expect(ATTACHMENT_COLUMN).toBe('attachment name');
  });

  /**
   * `ATTACHMENT_UUID_XPATH` was a module-level constant naming one
   * institution's schema extension, and the runner wrote it onto every item it
   * created. It is configuration now (`OEQ_ATTACHMENT_UUID_PATH`), defaulting
   * to unset. Asserted as an absence because `noUnusedLocals` is off in this
   * project: a re-introduced constant would compile, and a fallback to it
   * would write to a path outside the collection's schema again.
   */
  it('exports no default attachment-uuid xpath for anything to fall back to', () => {
    expect(Object.keys(types)).not.toContain('ATTACHMENT_UUID_XPATH');
  });
});
