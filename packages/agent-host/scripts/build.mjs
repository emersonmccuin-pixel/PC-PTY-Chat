// Bundle the packaged agent host. The dev host still runs through tsx; packaged
// Electron runs this file as a sibling Node process via ELECTRON_RUN_AS_NODE=1.

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

await build({
  entryPoints: [resolve(pkgRoot, 'src/cli.ts')],
  outfile: resolve(pkgRoot, 'dist/host.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['node-pty'],
  banner: {
    js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);",
  },
  sourcemap: 'linked',
  logLevel: 'info',
});
