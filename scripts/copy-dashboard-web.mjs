// Copies the buildless dashboard client (src/dashboard/web) into dist so the
// published package serves it from dist/dashboard/web — next to the tsc-compiled
// server.js, which resolves its static root as ./web relative to import.meta.url.
// Runs after `tsc` in the build script. No bundler involved.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const src = path.join(root, 'src', 'dashboard', 'web');
const dest = path.join(root, 'dist', 'dashboard', 'web');

await mkdir(dest, { recursive: true });
// Ship the client, but never the co-located *.test.ts/js files (they'd be dead
// weight served as static assets in the published package).
await cp(src, dest, {
  recursive: true,
  filter: (p) => !/\.test\.(ts|tsx|js)$/.test(p),
});
console.log(`copied dashboard client → ${path.relative(root, dest)}`);
