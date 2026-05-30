// CLI for the legacy → typed-edge YAML migration (Section 4h / 4h.7).
//
// Walks the given roots, finds every `*.yaml` workflow file, calls
// `migrateWorkflowText` on each, and rewrites the file in place after
// writing a `<file>.pre-4h.bak` snapshot. Idempotent: re-running on an
// already-migrated tree is a no-op.
//
// Usage:
//   node scripts/migrate-workflows-to-typed-refs.mjs <root...>
//
// Each root is recursively walked for `**/*.yaml`. Aborts on the first
// migration error, leaving prior files unchanged. The same library is
// invoked by the runtime's boot-time auto-migration in 4h.8.
//
// Exit codes:
//   0 — all files migrated cleanly OR already in the new shape
//   1 — one or more files failed to migrate
//   2 — bad usage (no roots given)

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Resolve the workflows package by relative path — scripts/ isn't inside any
// package's dependency graph, so the bare-specifier '@pc/workflows' doesn't
// resolve from here. The relative path works because tsx loads .ts directly.
import { migrateWorkflowText } from '../packages/workflows/src/index.ts';

function walkYaml(root, out) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkYaml(full, out);
    } else if (st.isFile() && name.endsWith('.yaml') && !name.endsWith('.pre-4h.bak')) {
      out.push(full);
    }
  }
}

function migrateFile(path) {
  const text = readFileSync(path, 'utf-8');
  const result = migrateWorkflowText(text);
  if (!result.ok) {
    return { path, status: 'failed', message: result.message };
  }
  if (result.status === 'already-typed') {
    return { path, status: 'already-typed' };
  }
  // Back up legacy file before rewriting. `.pre-4h.bak` is the agreed
  // suffix per D80 — running migration again skips it (walkYaml filter).
  writeFileSync(`${path}.pre-4h.bak`, text, 'utf-8');
  writeFileSync(path, result.text, 'utf-8');
  return { path, status: 'migrated' };
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node scripts/migrate-workflows-to-typed-refs.mjs <root...>');
  process.exit(2);
}
const files = [];
for (const root of roots) {
  walkYaml(resolve(root), files);
}
if (files.length === 0) {
  console.log('no .yaml files found under the given roots');
  process.exit(0);
}

const results = files.map(migrateFile);
let failed = 0;
for (const r of results) {
  if (r.status === 'failed') failed++;
  const tag = r.status === 'failed' ? 'FAILED' : r.status === 'migrated' ? 'OK    ' : 'skip  ';
  const detail = r.message ? `  ${r.message}` : '';
  console.log(`${tag} ${r.path}${detail}`);
}
const migrated = results.filter((r) => r.status === 'migrated').length;
const skipped = results.filter((r) => r.status === 'already-typed').length;
console.log(`\n${migrated} migrated, ${skipped} already-typed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
