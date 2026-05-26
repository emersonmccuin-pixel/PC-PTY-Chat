// Compile the Electron main + preload TS → CJS in dist/. esbuild (not tsc) so
// the build is fast and matches how packages/mcp bundles its server. `electron`
// is external (provided by the runtime); native server modules are only pulled
// in by the packaged server bundle (1.5), not here.

import { build } from 'esbuild';

await build({
  entryPoints: {
    main: 'src/main.ts',
    preload: 'src/preload.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});
