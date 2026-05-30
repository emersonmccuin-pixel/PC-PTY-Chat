// Section 16b.7 — agent-comms audit writers.
//
// Each writer (recordAgentInvoke / Pause / Answer / Completed / Failed):
//   - NOOPs cleanly when `workItemId` is null
//   - appends a typed WorkItemHistoryEntry on success
//   - includes a short human-readable `note` for the Activity tab
//
// DB-touching tests use an isolated PC_DATA_DIR + real migrations, same
// pattern as packages/db/test/work-items.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-agent-audit-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, createWorkItem, getWorkItem, runMigrations } = await import(
  '@pc/db'
);
const {
  recordAgentAnswer,
  recordAgentCompleted,
  recordAgentFailed,
  recordAgentInvoke,
  recordAgentPause,
} = await import('../src/services/agent-audit.ts');
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'doing', name: 'Doing', order: 1 },
];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkParent(slug: string): ULID {
  const p = createProject({ slug, name: slug, stages, folderPath: tmpDir });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'parent',
  });
  return wi.id as ULID;
}

test('recordAgentInvoke (async) writes a history row with mode + note', () => {
  const wid = mkParent('invoke-async');
  recordAgentInvoke({
    workItemId: wid,
    agentName: 'researcher',
    sessionId: 'sess-1',
    runId: 'run-1' as ULID,
    mode: 'async',
    input: 'compose a project status summary',
    now: Date.now(),
  });
  const wi = getWorkItem(wid);
  assert.ok(wi);
  assert.equal(wi.history.length, 1);
  const entry = wi.history[0]!;
  assert.equal(entry.kind, 'agent-invoke');
  assert.equal(entry.invokeMode, 'async');
  assert.equal(entry.agentName, 'researcher');
  assert.equal(entry.runId, 'run-1');
  assert.match(entry.note ?? '', /Dispatched researcher \(async\)/);
});

test('recordAgentInvoke (sync) writes mode=sync', () => {
  const wid = mkParent('invoke-sync');
  recordAgentInvoke({
    workItemId: wid,
    agentName: 'reviewer',
    sessionId: 'sess-2',
    runId: 'run-2' as ULID,
    mode: 'sync',
    input: 'review the diff',
    now: Date.now(),
  });
  const wi = getWorkItem(wid);
  assert.equal(wi?.history[0]?.invokeMode, 'sync');
  assert.match(wi?.history[0]?.note ?? '', /Invoked reviewer \(sync\)/);
});

test('recordAgentPause kinds map to the three entry kinds', () => {
  const wid = mkParent('pause-kinds');
  const now = Date.now();
  recordAgentPause({
    workItemId: wid,
    agentName: 'researcher',
    sessionId: 'sess-1',
    runId: 'run-1' as ULID,
    pendingAskId: 'ask-1' as ULID,
    kind: 'ask-orchestrator',
    prompt: 'what target audience?',
    now,
  });
  recordAgentPause({
    workItemId: wid,
    agentName: 'researcher',
    sessionId: 'sess-1',
    runId: 'run-1' as ULID,
    pendingAskId: 'ask-2' as ULID,
    kind: 'ask-user',
    prompt: 'pick a deadline',
    now,
  });
  recordAgentPause({
    workItemId: wid,
    agentName: 'researcher',
    sessionId: 'sess-1',
    runId: 'run-1' as ULID,
    pendingAskId: 'ask-3' as ULID,
    kind: 'approval',
    prompt: 'apply migration?',
    now,
  });
  const wi = getWorkItem(wid);
  assert.equal(wi?.history.length, 3);
  assert.deepEqual(
    wi?.history.map((e) => e.kind),
    ['agent-ask-orchestrator', 'agent-ask-user', 'agent-approval-request'],
  );
  assert.match(wi?.history[2]?.note ?? '', /requested approval/);
});

test('recordAgentAnswer carries answeredBy + pendingAskId', () => {
  const wid = mkParent('answer');
  recordAgentAnswer({
    workItemId: wid,
    agentName: 'researcher',
    sessionId: 'sess-1',
    runId: 'run-1' as ULID,
    pendingAskId: 'ask-1' as ULID,
    answeredBy: 'orchestrator',
    answer: 'small business owners in the trades',
    now: Date.now(),
  });
  const wi = getWorkItem(wid);
  const entry = wi?.history[0];
  assert.equal(entry?.kind, 'agent-answer');
  assert.equal(entry?.answeredBy, 'orchestrator');
  assert.equal(entry?.pendingAskId, 'ask-1');
  assert.match(entry?.note ?? '', /Orchestrator answered/);
});

test('recordAgentCompleted + recordAgentFailed land their kinds + notes', () => {
  const wid = mkParent('terminal');
  recordAgentCompleted({
    workItemId: wid,
    agentName: 'researcher',
    sessionId: 'sess-1',
    runId: 'run-1' as ULID,
    result: 'wrote the summary to scratchpad',
    now: Date.now(),
  });
  recordAgentFailed({
    workItemId: wid,
    agentName: 'writer',
    sessionId: 'sess-2',
    runId: 'run-2' as ULID,
    reason: 'API rate limit hit',
    cause: 'timeout',
    now: Date.now(),
  });
  const wi = getWorkItem(wid);
  assert.equal(wi?.history.length, 2);
  assert.equal(wi?.history[0]?.kind, 'agent-completed');
  assert.equal(wi?.history[1]?.kind, 'agent-failed');
  assert.equal(wi?.history[1]?.cause, 'timeout');
  assert.match(wi?.history[1]?.note ?? '', /writer failed \(timeout\)/);
});

test('all writers NOOP cleanly when workItemId is null', () => {
  // No throw, no DB write.
  recordAgentInvoke({
    workItemId: null,
    agentName: 'researcher',
    sessionId: 's',
    runId: 'r' as ULID,
    mode: 'sync',
    input: 'x',
    now: Date.now(),
  });
  recordAgentPause({
    workItemId: null,
    agentName: 'r',
    sessionId: 's',
    runId: null,
    pendingAskId: 'a' as ULID,
    kind: 'ask-user',
    prompt: 'q',
    now: Date.now(),
  });
  recordAgentAnswer({
    workItemId: null,
    agentName: 'r',
    sessionId: 's',
    runId: null,
    pendingAskId: 'a' as ULID,
    answeredBy: 'user',
    answer: 'a',
    now: Date.now(),
  });
  recordAgentCompleted({
    workItemId: null,
    agentName: 'r',
    sessionId: 's',
    runId: 'r' as ULID,
    result: '',
    now: Date.now(),
  });
  recordAgentFailed({
    workItemId: null,
    agentName: 'r',
    sessionId: 's',
    runId: 'r' as ULID,
    reason: 'x',
    cause: 'error',
    now: Date.now(),
  });
  // Nothing to assert — getting here without throwing is the test.
  assert.ok(true);
});

test('long inputs are clipped in the note', () => {
  const wid = mkParent('clip');
  const longInput = 'a'.repeat(500);
  recordAgentInvoke({
    workItemId: wid,
    agentName: 'r',
    sessionId: 's',
    runId: 'r' as ULID,
    mode: 'async',
    input: longInput,
    now: Date.now(),
  });
  const wi = getWorkItem(wid);
  const note = wi?.history[0]?.note ?? '';
  assert.ok(note.length < 300, `expected clipped note, got ${note.length} chars`);
  assert.match(note, /…$/);
});
