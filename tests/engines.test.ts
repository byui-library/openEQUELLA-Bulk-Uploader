import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * package.json declared no `engines`, so `npm install` on a machine running an
 * earlier 22.x failed without naming the cause. pdfjs-dist -- a RUNTIME
 * dependency, the one that reads every PDF -- needs Node >= 22.13.0, while the
 * repo and CI both say only "Node 22".
 *
 * This test exists so the declaration cannot silently fall behind the tree:
 * bumping a dependency whose own floor rises fails here rather than on an
 * operator's machine.
 */
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  engines?: { node?: string };
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { engines?: { node?: string }; dev?: boolean; optional?: boolean }>;
};

/** The lowest version a `>=X.Y.Z`-style range admits, as comparable numbers. */
function floorOf(range: string): [number, number, number] | null {
  const match = /(?:^|\|\|)\s*>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

const compare = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

describe('engines.node', () => {
  it('is declared at all', () => {
    expect(pkg.engines?.node).toBeTruthy();
  });

  /**
   * Runtime dependencies only. A dev/optional package's engine range is npm's
   * problem to skip, and one of them (a platform-specific linux-x64 binary)
   * asks for ^22.20, which is not a constraint to impose on everyone running
   * this tool.
   */
  it('is at least as strict as every runtime dependency in the lockfile', () => {
    const declared = floorOf(pkg.engines?.node ?? '');
    expect(declared, `engines.node '${pkg.engines?.node}' has no >= floor`).not.toBeNull();

    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === '' || entry.dev === true || entry.optional === true) continue;
      const required = entry.engines?.node ? floorOf(entry.engines.node) : null;
      if (required === null) continue;
      expect(
        compare(declared!, required) >= 0,
        `${path} needs node ${entry.engines?.node}, but engines.node is '${pkg.engines?.node}'`,
      ).toBe(true);
    }
  });

  it('covers pdfjs-dist specifically, the reason this constraint exists', () => {
    const pdfjs = lock.packages['node_modules/pdfjs-dist']?.engines?.node;
    expect(pdfjs).toBeTruthy();
    expect(compare(floorOf(pkg.engines?.node ?? '')!, floorOf(pdfjs!)!)).toBeGreaterThanOrEqual(0);
  });
});
