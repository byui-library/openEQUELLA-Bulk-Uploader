import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist-desktop/desktop/ui', { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  await cp(`src/desktop/ui/${f}`, `dist-desktop/desktop/ui/${f}`).catch(() => {});
}
