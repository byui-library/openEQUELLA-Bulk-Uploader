import { describe, it, expect } from 'vitest';
import { stripElectronWrapper, errorMessage } from '../../../src/desktop/ui/errors.js';

describe('stripElectronWrapper', () => {
  it('strips a wrapped OeqError down to its bare message', () => {
    const raw =
      "Error invoking remote method 'oeq:signIn': OeqError: Sign-in timed out.";
    expect(stripElectronWrapper(raw)).toBe('Sign-in timed out.');
  });

  it('strips a wrapped plain Error down to its bare message', () => {
    const raw = "Error invoking remote method 'oeq:validate': Error: plain error text";
    expect(stripElectronWrapper(raw)).toBe('plain error text');
  });

  it('leaves an unwrapped message completely untouched', () => {
    // Never passed through ipcRenderer.invoke() -- no "Error invoking remote
    // method" prefix at all. Must come back byte-for-byte identical, even
    // though it happens to start with something that could otherwise look
    // like a class-name prefix (a bare Windows drive letter).
    const raw = 'C:\\Users\\someone\\file.xlsx: parse failed';
    expect(stripElectronWrapper(raw)).toBe(raw);
  });

  it('does not truncate a message containing colons that are not the wrapper', () => {
    // The exact shape a real per-row upload failure takes.
    const raw =
      "Error invoking remote method 'oeq:run': OeqError: Row 14 (Sears, Rivka 072126.MP4): POST /api/item failed";
    expect(stripElectronWrapper(raw)).toBe('Row 14 (Sears, Rivka 072126.MP4): POST /api/item failed');
  });

  it('strips only ONE class-name prefix, so a Windows path with a drive letter survives', () => {
    // Live-verified shape: SheetError built from `${path}: ${message}`
    // (core/sheet.ts) wrapped by Electron. The naive fix (stripping any
    // leading `word:` unconditionally) would eat the drive letter's own
    // colon on the second pass -- this asserts it does not.
    const raw =
      "Error invoking remote method 'oeq:validate': SheetError: C:\\Users\\someone\\file.xlsx: parse failed";
    expect(stripElectronWrapper(raw)).toBe('C:\\Users\\someone\\file.xlsx: parse failed');
  });

  it('leaves a wrapped non-Error-shaped rejection (no class-name segment) alone', () => {
    // Live-verified: throwing/rejecting a bare string or number still comes
    // back `instanceof Error`, but with no "<ClassName>: " segment at all --
    // just "Error invoking remote method '<channel>': <value>".
    const raw = "Error invoking remote method 'oeq:run': boom-string-value";
    expect(stripElectronWrapper(raw)).toBe('boom-string-value');
  });
});

describe('errorMessage', () => {
  it('strips the Electron wrapper from a rejected Error', () => {
    const err = new Error(
      "Error invoking remote method 'oeq:signIn': OeqError: Sign-in window was closed before completing.",
    );
    expect(errorMessage(err)).toBe('Sign-in window was closed before completing.');
  });

  it('stringifies a non-Error value rather than throwing or returning [object Object]-style noise for a plain string', () => {
    expect(errorMessage('just a string')).toBe('just a string');
  });

  it('stringifies a non-Error value such as a number', () => {
    expect(errorMessage(42)).toBe('42');
  });

  it('stringifies a non-Error, non-primitive value without crashing', () => {
    expect(errorMessage({ code: 'ENOENT' })).toBe('[object Object]');
  });
});
