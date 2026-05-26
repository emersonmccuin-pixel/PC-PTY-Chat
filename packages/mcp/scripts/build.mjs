// Section 20.A.1 — Pre-built MCP server bundle.
//
// Replaces `npx -y tsx packages/mcp/src/server.ts` in per-project .mcp.json.
// Cold-spawn time drops from 2-5s to <500ms; npx cache contention under
// back-to-back agent dispatch goes away.
//
// Output: packages/mcp/dist/server.mjs (ESM, top-level await preserved).
// Rebuilt automatically on `pnpm install` via the package `prepare` script.
//
// Pass `--watch` to keep rebuilding on src change — `pnpm dev` runs this
// alongside the API watcher so new tools in src/server.ts land in dist before
// the next `+ New session` spawn picks them up (C#4 carry-over from the
// matrix-smoke session, which lost ~15min chasing a stale bundle).

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const buildOptions = {
  entryPoints: [resolve(pkgRoot, 'src/server.ts')],
  outfile: resolve(pkgRoot, 'dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'linked',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log('[mcp] watching src/server.ts for changes (dist/server.mjs rebuilds on save)');
} else {
  await build(buildOptions);
}
