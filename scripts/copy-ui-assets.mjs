import { cp, mkdir } from 'node:fs/promises';

/**
 * These assets are REQUIRED, not optional. An app whose dist-desktop is
 * missing index.html or styles.css opens a BLANK WINDOW -- this project's
 * known catastrophic failure mode, and one that says nothing on the terminal,
 * so it took a full debugging session to diagnose the last time it happened.
 *
 * This step used to end in `.catch(() => {})`, which meant a build that copied
 * nothing at all still exited 0 and reported success. Fail loudly here
 * instead: a broken build is cheap, a broken build that looks fine is not.
 */
await mkdir('dist-desktop/desktop/ui', { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  try {
    await cp(`src/desktop/ui/${f}`, `dist-desktop/desktop/ui/${f}`);
  } catch (cause) {
    console.error(
      `copy-ui-assets: could not copy required asset 'src/desktop/ui/${f}' to ` +
        `'dist-desktop/desktop/ui/${f}'. Without it the app window opens blank.\n` +
        `  ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    process.exit(1);
  }
}
