import { describe, it, expect } from 'vitest';
import { checkIndexFlags } from '../src/cli/indexPage.js';

describe('oeq-upload index flags', () => {
  it('previews when given no destination', () => {
    expect(checkIndexFlags({ template: 't.json' })).toEqual({ out: null, upload: null });
  });
  it('requires exactly one of --draft and --publish with --upload', () => {
    expect(() => checkIndexFlags({ template: 't', upload: true })).toThrow(/--draft or --publish/);
    expect(() => checkIndexFlags({ template: 't', upload: true, draft: true, publish: true })).toThrow(/--draft or --publish/);
    expect(checkIndexFlags({ template: 't', upload: true, publish: true }).upload).toEqual({ draft: false });
  });
  it('refuses --force without --out, and --draft/--publish without --upload', () => {
    expect(() => checkIndexFlags({ template: 't', force: true })).toThrow(/--force/);
    expect(() => checkIndexFlags({ template: 't', draft: true })).toThrow(/--upload/);
  });
});
