// Unit tests for workflow-boot-migration.ts (Section 4h / 4h.8 / D80).
//
// Pins the boot-time migration contract:
//   - Missing directory → returns empty stats (server boot-survivable).
//   - Legacy YAML → rewritten in place; `<file>.pre-4h.bak` written first.
//   - Already-typed YAML → skipped (no .bak, no rewrite).
//   - Un-migratable YAML → throws with the offending file path in the
//     error message + a recovery hint.
//   - `.pre-4h.bak` files are not re-scanned.
//   - Non-`.yaml` files are ignored.
//
// Run via:  pnpm --filter @pc/server test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrateWorkflowsInPlace } from '../src/services/workflow-boot-migration.ts';

const LEGACY_YAML = `id: t
triggers:
  on_enter: { stage_id: review }
attached_to_work_item: required
inputs:
  workItemId: ulid
nodes:
  - id: attach
    attach-to-work-item:
      workItemId: $inputs.workItemId
      name: notes.md
      content: hi
`;

const ALREADY_TYPED_YAML = `id: t
triggers:
  callable: true
nodes:
  - id: dispatch
    subagent: researcher
    prompt: hello
`;

const UN_MIGRATABLE_YAML = `id: t
triggers:
  callable: true
nodes:
  - id: dispatch
    subagent: $inputs.agent
    prompt: hello
`;

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'pc-boot-migrate-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('migrateWorkflowsInPlace: missing dir → empty stats, no throw', () => {
  const dir = join(tmpdir(), `pc-boot-migrate-missing-${Date.now()}`);
  const stats = migrateWorkflowsInPlace(dir);
  assert.deepEqual(stats, { migrated: [], alreadyTyped: [] });
});

test('migrateWorkflowsInPlace: legacy file → rewritten + .pre-4h.bak written', () => {
  const dir = mkTmp();
  try {
    const file = resolve(dir, 'legacy.yaml');
    writeFileSync(file, LEGACY_YAML, 'utf-8');

    const stats = migrateWorkflowsInPlace(dir);
    assert.equal(stats.migrated.length, 1);
    assert.equal(stats.migrated[0], file);
    assert.equal(stats.alreadyTyped.length, 0);

    // Backup carries the original byte-for-byte.
    assert.ok(existsSync(`${file}.pre-4h.bak`), 'backup must be written');
    assert.equal(readFileSync(`${file}.pre-4h.bak`, 'utf-8'), LEGACY_YAML);

    // Main file now in new shape.
    const after = readFileSync(file, 'utf-8');
    assert.match(after, /workItemId: ['"]@trigger\.workItemId['"]/);
    assert.doesNotMatch(after, /\binputs:/m);
  } finally {
    cleanup(dir);
  }
});

test('migrateWorkflowsInPlace: already-typed file → no rewrite, no backup', () => {
  const dir = mkTmp();
  try {
    const file = resolve(dir, 'typed.yaml');
    writeFileSync(file, ALREADY_TYPED_YAML, 'utf-8');

    const stats = migrateWorkflowsInPlace(dir);
    assert.equal(stats.migrated.length, 0);
    assert.equal(stats.alreadyTyped.length, 1);
    assert.equal(stats.alreadyTyped[0], file);

    assert.equal(existsSync(`${file}.pre-4h.bak`), false, 'no backup for already-typed');
    assert.equal(readFileSync(file, 'utf-8'), ALREADY_TYPED_YAML);
  } finally {
    cleanup(dir);
  }
});

test('migrateWorkflowsInPlace: un-migratable file → throws with file path + recovery hint', () => {
  const dir = mkTmp();
  try {
    const file = resolve(dir, 'broken.yaml');
    writeFileSync(file, UN_MIGRATABLE_YAML, 'utf-8');

    assert.throws(
      () => migrateWorkflowsInPlace(dir),
      (err: Error) => {
        assert.match(err.message, /cannot migrate workflow file/);
        assert.match(err.message, /broken\.yaml/);
        assert.match(err.message, /Hand-edit the file/);
        return true;
      },
    );

    // No partial state — un-migratable file aborts BEFORE the rewrite, so
    // no .pre-4h.bak is left behind for it.
    assert.equal(existsSync(`${file}.pre-4h.bak`), false);
  } finally {
    cleanup(dir);
  }
});

test('migrateWorkflowsInPlace: .pre-4h.bak files are not re-scanned', () => {
  const dir = mkTmp();
  try {
    const file = resolve(dir, 'legacy.yaml');
    writeFileSync(file, LEGACY_YAML, 'utf-8');

    // First run migrates.
    migrateWorkflowsInPlace(dir);

    // Second run: the .pre-4h.bak now exists alongside the migrated file.
    // It must NOT be picked up as a workflow file to migrate.
    const stats = migrateWorkflowsInPlace(dir);
    assert.equal(stats.migrated.length, 0);
    assert.equal(stats.alreadyTyped.length, 1, 'only the .yaml, not the .pre-4h.bak');
  } finally {
    cleanup(dir);
  }
});

test('migrateWorkflowsInPlace: non-.yaml files are ignored', () => {
  const dir = mkTmp();
  try {
    writeFileSync(resolve(dir, 'README.md'), '# notes', 'utf-8');
    writeFileSync(resolve(dir, 'config.json'), '{}', 'utf-8');
    writeFileSync(resolve(dir, 'sample.yaml'), ALREADY_TYPED_YAML, 'utf-8');

    const stats = migrateWorkflowsInPlace(dir);
    assert.equal(stats.alreadyTyped.length, 1);
    assert.equal(stats.migrated.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('migrateWorkflowsInPlace: stops at first un-migratable file (some prior files may be rewritten)', () => {
  // Per D80: partial-progress files written prior remain on disk. The
  // user sees a clear error pointing at the failing file; their on-disk
  // state is recoverable via the .pre-4h.bak the migrator created for
  // each rewrite.
  const dir = mkTmp();
  try {
    // readdirSync order isn't formally specified — name the files so the
    // good one sorts BEFORE the bad one to make the test deterministic
    // on Windows + Linux.
    const okFile = resolve(dir, '00-ok.yaml');
    const badFile = resolve(dir, '99-bad.yaml');
    writeFileSync(okFile, LEGACY_YAML, 'utf-8');
    writeFileSync(badFile, UN_MIGRATABLE_YAML, 'utf-8');

    assert.throws(() => migrateWorkflowsInPlace(dir));

    // Good file: rewritten + backed up.
    assert.ok(existsSync(`${okFile}.pre-4h.bak`));
    const okText = readFileSync(okFile, 'utf-8');
    assert.match(okText, /workItemId: ['"]@trigger\.workItemId['"]/);

    // Bad file: untouched.
    assert.equal(readFileSync(badFile, 'utf-8'), UN_MIGRATABLE_YAML);
    assert.equal(existsSync(`${badFile}.pre-4h.bak`), false);
  } finally {
    cleanup(dir);
  }
});
