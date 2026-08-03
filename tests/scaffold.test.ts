import { describe, it, expect } from 'vitest';
import { ATTACHMENT_COLUMN, ATTACHMENT_UUID_XPATH } from '../src/core/types.js';

describe('scaffold', () => {
  it('exposes the reserved column and uuid xpath constants', () => {
    expect(ATTACHMENT_COLUMN).toBe('attachment name');
    expect(ATTACHMENT_UUID_XPATH).toBe('BYUI_extended/attachments/attachment');
  });
});
