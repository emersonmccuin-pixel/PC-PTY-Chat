// Section 20.A.1 — Pre-built MCP server bundle.
//
// Replaces `npx -y tsx packages/mcp/src/server.ts` in per-project .mcp.json.
// Cold-spawn time drops from 2-5s to <500ms; npx cache contention under
// back-to-back agent dispatch goes away.
//
// Output: packages/mcp/dist/server.mjs (ESM, top-level await preserved).
// Rebuilt automatically on `pnpm install` via the package `prepare` script.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

await build({
  entryPoints: [resolve(pkgRoot, 'src/server.ts')],
  outfile: resolve(pkgRoot, 'dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'linked',
  logLevel: 'info',
});
