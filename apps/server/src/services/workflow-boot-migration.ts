// Boot-time workflow YAML migration (Section 4h / 4h.8 / D80).
//
// Walks a workflows directory and rewrites every legacy-shape YAML into the
// new typed-edge form before the registry reads them. Idempotent: files
// already in the new shape are skipped at near-zero cost. Per D80, any
// migration failure throws — the runtime refuses to start with a clear
// error pointing at the broken file rather than load malformed YAML.
//
// Pre-rewrite backup: each rewrite writes `<file>.pre-4h.bak` first, then
// overwrites the original. Backup is left in place so the user can restore
// or hand-edit. Files ending `.pre-4h.bak` are skipped on re-scan.
//
// Pure side-effect on `fs`; no DB / channel / WS coupling. Reusable from
// both ProjectRuntime's lazy registry-init path and from one-shot tooling.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrateWorkflowText } from '@pc/workflows';

export interface BootMigrationStats {
  /** Files rewritten on disk this run. */
  readonly migrated: readonly string[];
  /** Files that were already in the new shape (no write happened). */
  readonly alreadyTyped: readonly string[];
}

/** Migrate every `*.yaml` file under `dir` in place. Throws on the first
 *  un-migratable file; partial-progress files written prior remain on
 *  disk along with their `.pre-4h.bak` backups (the runtime never reaches
 *  the registry-load path on this attempt — the user gets a clear error
 *  and a recoverable on-disk state). */
export function migrateWorkflowsInPlace(dir: string): BootMigrationStats {
  if (!existsSync(dir)) {
    return { migrated: [], alreadyTyped: [] };
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `cannot read workflows directory ${dir}: ${(err as Error).message}`,
    );
  }

  const migrated: string[] = [];
  const alreadyTyped: string[] = [];

  for (const name of entries) {
    if (!name.endsWith('.yaml')) continue;
    if (name.endsWith('.pre-4h.bak')) continue;
    const full = resolve(dir, name);

    let text: string;
    try {
      text = readFileSync(full, 'utf-8');
    } catch (err) {
      throw new Error(
        `cannot read workflow file ${full}: ${(err as Error).message}`,
      );
    }

    const result = migrateWorkflowText(text);
    if (!result.ok) {
      throw new Error(
        `cannot migrate workflow file ${full}: ${result.message}\n` +
          `Hand-edit the file (the original is preserved on disk) or remove it, then restart.`,
      );
    }

    if (result.status === 'already-typed') {
      alreadyTyped.push(full);
      continue;
    }

    // Write backup first so we can never lose the original even if the
    // in-place rewrite fails mid-write.
    try {
      writeFileSync(`${full}.pre-4h.bak`, text, 'utf-8');
    } catch (err) {
      throw new Error(
        `cannot write workflow backup ${full}.pre-4h.bak: ${(err as Error).message}`,
      );
    }
    try {
      writeFileSync(full, result.text, 'utf-8');
    } catch (err) {
      throw new Error(
        `cannot write migrated workflow ${full}: ${(err as Error).message}`,
      );
    }
    migrated.push(full);
  }

  return { migrated, alreadyTyped };
}
