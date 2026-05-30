// Section 35 — callsign migration backfill.
//
// Exercises the recursive-CTE backfill from `0021_work_item_callsigns.sql`.
// Approach: spin up a fresh migrated DB, manually NULL out the callsigns
// (the migration already populated them on its first pass, and createWorkItem
// claims a fresh callsign on every insert — so we need to reset the column
// to simulate the "pre-migration" state), then re-run the backfill SQL and
// assert the assignments match the spec:
//   - non-agent roots numbered per-project in (createdAt, id) order;
//   - non-agent children get .M over non-agent siblings;
//   - non-agent child of an agent-contract parent gets a top-level number;
//   - agent contracts stay NULL.
//
// Also verifies projects.callsign_seq lands at the count of effective roots.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'drizzle');

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-callsign-mig-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, getDb, newId } = await import('../src/index.ts');

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Extract only the backfill statements (everything AFTER the schema
 *  ALTER + CREATE INDEX). The migration mixes DDL with the backfill
 *  UPDATEs; we want to re-run only the data UPDATE portion. */
function readBackfillSql(): string {
  const full = readFileSync(join(migrationsDir, '0021_work_item_callsigns.sql'), 'utf8');
  const parts = full.split('--> statement-breakpoint');
  // Statement 0: ALTER ADD callsign_seq.
  // Statement 1: ALTER ADD callsign.
  // Statement 2: CREATE UNIQUE INDEX.
  // Statement 3: backfill UPDATE work_items.
  // Statement 4: backfill UPDATE projects.callsign_seq.
  return parts.slice(3).join('\n');
}

test('migration backfill assigns callsigns over a pre-seeded DB', () => {
  const projectId = newId();
  const sqlite = (getDb() as unknown as { $client: Database.Database }).$client;

  sqlite
    .prepare(
      `INSERT INTO projects (id, slug, name, settings, stages, folder_path, position, kind, callsign_seq, created_at, updated_at)
       VALUES (?, 'mig', 'Mig', '{}', '[]', '/x', 0, 'standard', 0, ?, ?)`,
    )
    .run(projectId, 1000, 1000);

  // Insert a mixed tree directly (bypassing createWorkItem so callsign stays NULL).
  // Tree:
  //   root1   (non-agent)  — createdAt 1100
  //     ag    (agent)
  //       u1  (non-agent child-of-agent → fallback to top-level)
  //     c1    (non-agent child of root1) — createdAt 1300
  //     c2    (non-agent child of root1) — createdAt 1400
  //       gc1 (non-agent grandchild)
  //   root2   (non-agent)  — createdAt 1110
  const insertWi = sqlite.prepare(
    `INSERT INTO work_items (
       id, project_id, parent_id, title, body, stage_id, status,
       type, fields, history, position, version,
       is_agent_task, ephemeral,
       acceptance_criteria, expected_output,
       verification_tier, verification_status, verification_notes,
       assigned_agent_run_id, worktree_path, tagged_project_id,
       callsign,
       created_at, updated_at
     ) VALUES (
       @id, @project, @parent, @title, '', 'backlog', 'pending',
       'task', '{}', '[]', 0, 1,
       @agent, 0,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL,
       @createdAt, @createdAt
     )`,
  );

  const root1Id = newId();
  const root2Id = newId();
  const agId = newId();
  const u1Id = newId();
  const c1Id = newId();
  const c2Id = newId();
  const gc1Id = newId();

  insertWi.run({
    id: root1Id,
    project: projectId,
    parent: null,
    title: 'root1',
    agent: 0,
    createdAt: 1100,
  });
  insertWi.run({
    id: root2Id,
    project: projectId,
    parent: null,
    title: 'root2',
    agent: 0,
    createdAt: 1110,
  });
  insertWi.run({
    id: agId,
    project: projectId,
    parent: root1Id,
    title: 'agent',
    agent: 1,
    createdAt: 1200,
  });
  insertWi.run({
    id: u1Id,
    project: projectId,
    parent: agId,
    title: 'user child of agent',
    agent: 0,
    createdAt: 1250,
  });
  insertWi.run({
    id: c1Id,
    project: projectId,
    parent: root1Id,
    title: 'c1',
    agent: 0,
    createdAt: 1300,
  });
  insertWi.run({
    id: c2Id,
    project: projectId,
    parent: root1Id,
    title: 'c2',
    agent: 0,
    createdAt: 1400,
  });
  insertWi.run({
    id: gc1Id,
    project: projectId,
    parent: c2Id,
    title: 'gc1',
    agent: 0,
    createdAt: 1500,
  });

  // Reset callsigns + the project seq to mimic the pre-migration state.
  sqlite.prepare(`UPDATE work_items SET callsign = NULL WHERE project_id = ?`).run(projectId);
  sqlite.prepare(`UPDATE projects SET callsign_seq = 0 WHERE id = ?`).run(projectId);

  // Run the backfill SQL.
  sqlite.exec(readBackfillSql());

  // Verify.
  const get = (id: string) =>
    sqlite.prepare(`SELECT callsign FROM work_items WHERE id = ?`).get(id) as
      | { callsign: string | null }
      | undefined;

  // Effective roots in createdAt order: root1 (1100), root2 (1110), u1 (1250,
  // because its parent agent has no callsign). Numbers 1..3.
  assert.equal(get(root1Id)?.callsign, 'mig-1');
  assert.equal(get(root2Id)?.callsign, 'mig-2');
  assert.equal(get(u1Id)?.callsign, 'mig-3');

  // Children of root1 (non-agent) in createdAt order: c1 first, c2 second.
  assert.equal(get(c1Id)?.callsign, 'mig-1.1');
  assert.equal(get(c2Id)?.callsign, 'mig-1.2');

  // Grandchild of root1 via c2.
  assert.equal(get(gc1Id)?.callsign, 'mig-1.2.1');

  // Agent contracts stay NULL.
  assert.equal(get(agId)?.callsign, null);

  // projects.callsign_seq lands at 3 (the count of effective roots).
  const seq = sqlite
    .prepare(`SELECT callsign_seq FROM projects WHERE id = ?`)
    .get(projectId) as { callsign_seq: number } | undefined;
  assert.equal(seq?.callsign_seq, 3);
});
