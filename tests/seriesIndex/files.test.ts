import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveIndexFiles } from '../../src/core/seriesIndex/files.js';

const files = { 'index.html': '<h1>x</h1>', 'index.css': 'a{}', 'index.js': ';' };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-index-'));
});

describe('saveIndexFiles', () => {
  it('writes the three files', async () => {
    const r = await saveIndexFiles(dir, files, false);
    expect(r).toEqual({ kind: 'saved', paths: ['index.html', 'index.css', 'index.js'].map((n) => join(dir, n)) });
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe('<h1>x</h1>');
  });

  it('writes nothing while any of the three already exists, and names them', async () => {
    await writeFile(join(dir, 'index.css'), 'mine');
    await writeFile(join(dir, 'other.txt'), 'untouched');
    const r = await saveIndexFiles(dir, files, false);
    expect(r).toEqual({ kind: 'exists', names: ['index.css'] });
    expect(await readFile(join(dir, 'index.css'), 'utf8')).toBe('mine');
    expect((await readdir(dir)).sort()).toEqual(['index.css', 'other.txt']);
  });

  it('replaces them when told to, leaving other files alone', async () => {
    await writeFile(join(dir, 'index.css'), 'mine');
    await writeFile(join(dir, 'other.txt'), 'untouched');
    await saveIndexFiles(dir, files, true);
    expect(await readFile(join(dir, 'index.css'), 'utf8')).toBe('a{}');
    expect(await readFile(join(dir, 'other.txt'), 'utf8')).toBe('untouched');
  });
});
