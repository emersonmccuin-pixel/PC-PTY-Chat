// Section 10 Phase 1.5 — assemble the packaged server resource tree.
//
// electron-builder ships this dir as `extraResources` → `<resources>/pcserver/`.
// The desktop main process sets PC_ROOT to it, so the server's ROOT-relative
// path resolution (apps/web/dist, templates, packages/mcp/dist, channel-server)
// lands here unchanged. Layout mirrors the repo's sub-paths:
//
//   pcserver/
//     server.mjs                     bundled API+channel server (in-process host)
//     apps/web/dist/                 web UI (PUBLIC)
//     templates/                     project scaffold templates
//     packages/mcp/dist/server.mjs   pc-rig MCP server (self-contained; spawned)
//     channel-server/server.js       webhook bridge (bundled; spawned)
//     node_modules/                  server externals (better-sqlite3, node-pty)
//
// Native deps are the only non-bundled pieces: node-pty ships N-API prebuilds
// (ABI-stable, copied as-is); better-sqlite3 is V8-ABI and gets rebuilt for
// Electron by rebuild-native.mjs after this stages it.

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRUNK = resolve(__dirname, '..', '..', '..');
const STAGING = resolve(__dirname, '..', 'staging');
const OUT = join(STAGING, 'pcserver');
const PNPM = join(TRUNK, 'node_modules', '.pnpm');

const NODE_PTY = 'node-pty@1.1.0';
const BETTER_SQLITE3 = 'better-sqlite3@11.10.0';
const FILE_URI_TO_PATH = 'file-uri-to-path@1.0.0';

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// dereference: pnpm stores deps as symlinks into `.pnpm`; the staged tree must
// be real files (Windows can't recreate the symlinks unprivileged, and the
// packaged app must be self-contained).
const copy = (from, to) => cpSync(from, join(OUT, to), { recursive: true, dereference: true });

// 1. server bundle
copy(resolve(TRUNK, 'apps/server/dist/server.mjs'), 'server.mjs');
copy(resolve(TRUNK, 'apps/server/dist/server.mjs.map'), 'server.mjs.map');

// 2. web UI
copy(resolve(TRUNK, 'apps/web/dist'), 'apps/web/dist');

// 3. scaffold templates
copy(resolve(TRUNK, 'templates'), 'templates');

// 3b. Drizzle migrations (read at runtime by runMigrations via ROOT-relative path)
copy(resolve(TRUNK, 'packages/db/drizzle'), 'packages/db/drizzle');

// 4. pc-rig MCP server (self-contained bundle)
copy(resolve(TRUNK, 'packages/mcp/dist/server.mjs'), 'packages/mcp/dist/server.mjs');
copy(resolve(TRUNK, 'packages/mcp/dist/server.mjs.map'), 'packages/mcp/dist/server.mjs.map');

// 5. channel-server — bundle it self-contained so no node_modules ship for it
await build({
  entryPoints: [resolve(TRUNK, 'channel-server/server.js')],
  outfile: join(OUT, 'channel-server/server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

// 6. native externals for the server bundle
const NM = 'node_modules';
copy(join(PNPM, NODE_PTY, 'node_modules/node-pty'), join(NM, 'node-pty'));
for (const dep of ['better-sqlite3', 'bindings', 'prebuild-install']) {
  copy(join(PNPM, BETTER_SQLITE3, 'node_modules', dep), join(NM, dep));
}
// `bindings` requires `file-uri-to-path` at runtime — its own pnpm entry.
copy(join(PNPM, FILE_URI_TO_PATH, 'node_modules/file-uri-to-path'), join(NM, 'file-uri-to-path'));

// 7. package.json declaring the native deps — @electron/rebuild walks this
// dependency graph to find what to rebuild; without the deps listed it
// silently no-ops and the Node-ABI binary ships (NODE_MODULE_VERSION mismatch
// at runtime). Versions mirror the staged copies.
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'pcserver',
      version: '0.0.0',
      private: true,
      dependencies: { 'better-sqlite3': '11.10.0', 'node-pty': '1.1.0' },
    },
    null,
    2,
  ) + '\n',
);

console.log('staged →', OUT);
