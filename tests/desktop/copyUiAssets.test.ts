import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = resolve('scripts/copy-ui-assets.mjs');

/**
 * index.html and styles.css are not optional extras: a dist-desktop missing
 * either produces an app whose window opens BLANK. That is this project's
 * known catastrophic failure mode -- the one that cost a full debugging
 * session -- and it is invisible, because a blank window puts nothing on the
 * terminal. The copy step used to swallow every error with `.catch(() => {})`,
 * so the build reported success and shipped the broken app.
 *
 * Driven as a real subprocess because the script is a top-level program, not a
 * module with an entry point to call, and because the thing under test is its
 * EXIT CODE.
 */
async function copyUiAssets(cwd: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT], { cwd });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, output: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-copy-ui-'));
  await mkdir(join(dir, 'src/desktop/ui'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('copy-ui-assets', () => {
  it('copies both assets when both are present', async () => {
    await writeFile(join(dir, 'src/desktop/ui/index.html'), '<!doctype html>');
    await writeFile(join(dir, 'src/desktop/ui/styles.css'), 'body{}');

    const { code } = await copyUiAssets(dir);

    expect(code).toBe(0);
    expect(await readFile(join(dir, 'dist-desktop/desktop/ui/index.html'), 'utf8')).toBe(
      '<!doctype html>',
    );
    expect(await readFile(join(dir, 'dist-desktop/desktop/ui/styles.css'), 'utf8')).toBe('body{}');
  });

  it('fails the build when index.html is missing, naming the file', async () => {
    await writeFile(join(dir, 'src/desktop/ui/styles.css'), 'body{}');

    const { code, output } = await copyUiAssets(dir);

    expect(code).not.toBe(0);
    expect(output).toContain('index.html');
  });

  it('fails the build when styles.css is missing, naming the file', async () => {
    await writeFile(join(dir, 'src/desktop/ui/index.html'), '<!doctype html>');

    const { code, output } = await copyUiAssets(dir);

    expect(code).not.toBe(0);
    expect(output).toContain('styles.css');
  });
});
