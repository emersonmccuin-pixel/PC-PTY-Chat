// Section 10 Phase 1.5 — bundle the API + channel server for the packaged
// Electron app. In dev the server runs via `tsx src/index.ts`; a packaged app
// has no tsx, so the desktop main process imports this bundle instead.
//
// Output: apps/server/dist/server.mjs (ESM, top-level await preserved — the
// boot sequence awaits the Quick Tasks seed). Native modules stay external:
// they ship as Electron-ABI .node binaries resolved from node_modules at
// runtime, not bundled. Mirrors packages/mcp/scripts/build.mjs.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

await build({
  entryPoints: [resolve(pkgRoot, 'src/index.ts')],
  outfile: resolve(pkgRoot, 'dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Native addons can't be bundled — keep them as runtime imports resolved
  // from the packaged node_modules (rebuilt against Electron's ABI at package
  // time, 1.2).
  external: ['better-sqlite3', 'node-pty'],
  // ESM output bundling CJS deps (ws does `require('events')`) needs a real
  // `require` in scope so esbuild's require-shim resolves Node builtins instead
  // of throwing "Dynamic require of … is not supported".
  banner: {
    js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);",
  },
  sourcemap: 'linked',
  logLevel: 'info',
});
