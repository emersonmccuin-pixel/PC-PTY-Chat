// Section 10 Phase 1.5 / 1.2 — rebuild the staged better-sqlite3 against
// Electron's V8 ABI. node-pty is N-API (ABI-stable) and needs no rebuild, so
// only better-sqlite3 is targeted. Runs against the staging tree, never the
// dev node_modules — so `pnpm dev` keeps its Node-ABI build intact.

import { rebuild } from '@electron/rebuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'staging', 'pcserver');
// Defaults to the installed Electron; PC_REBUILD_ELECTRON overrides so the
// better-sqlite3 prebuilt/compile matrix can be probed against a target
// version before committing to a reinstall.
const electronVersion =
  process.env.PC_REBUILD_ELECTRON?.trim() ||
  createRequire(import.meta.url)('electron/package.json').version;

console.log(`rebuilding better-sqlite3 for Electron ${electronVersion} in ${OUT}`);
await rebuild({
  buildPath: OUT,
  electronVersion,
  onlyModules: ['better-sqlite3'],
  force: true,
});
console.log('native rebuild done');
