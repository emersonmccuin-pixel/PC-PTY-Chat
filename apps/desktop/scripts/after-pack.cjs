// Section 10 Phase 1.5 — electron-builder strips `node_modules` from
// extraResources copies (it assumes it owns dependency collection). The
// packaged server bundle needs its native externals (better-sqlite3 rebuilt
// for Electron's ABI + node-pty's N-API prebuilds), so copy the staged
// node_modules into the packed app ourselves, after packing.

const { cpSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

exports.default = async function afterPack(context) {
  const src = resolve(__dirname, '..', 'staging', 'pcserver', 'node_modules');
  if (!existsSync(src)) {
    throw new Error(`[afterPack] staged node_modules missing — run \`pnpm stage && pnpm rebuild:native\` first (${src})`);
  }
  const dest = join(context.appOutDir, 'resources', 'pcserver', 'node_modules');
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log('[afterPack] copied server node_modules →', dest);
};
