// Section 25 Session 8 — pending_asks_v2 repo.
//
// Lives alongside v1's `pending-asks.ts` during the parallel-build phase.
// Same answer-once contract (atomic open→answered transition) against the
// v2 table + the bare v2 kind taxonomy ('orchestrator' | 'user' | 'approval'
// per design §1's identifier glossary).
//
// Status transitions are atomic via WHERE status='open' guards — JSONL-replay
// re-delivery of an already-handled event cannot double-resume the child.

import { and, asc, eq } from 'drizzle-orm';

import type {
  PendingAskKindV2,
  PendingAskOption,
  PendingAskRowV2,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { pendingAsks } from '../schema-v2.ts';

export interface CreatePendingAskV2Input {
  id: ULID;
  agentRunId: ULID;
  ccSessionId: string;
  projectId: ULID;
  parentWorkItemId?: ULID | null;
  kind: PendingAskKindV2;
  promptBody: string;
  context?: string | null;
  options?: PendingAskOption[] | null;
  now: number;
}

/** Write one open pending-ask row. Caller mints the ULID so the
 *  `agent-asks-*` event body can reference it before the row is fully
 *  persisted. */
export function createPendingAskV2(input: CreatePendingAskV2Input): PendingAskRowV2 {
  const row: PendingAskRowV2 = {
    id: input.id,
    agentRunId: input.agentRunId,
    ccSessionId: input.ccSessionId,
    projectId: input.projectId,
    parentWorkItemId: input.parentWorkItemId ?? null,
    kind: input.kind,
    promptBody: input.promptBody,
    context: input.context ?? null,
    options: input.options ?? null,
    status: 'open',
    answerBody: null,
    answeredBy: null,
    createdAt: input.now,
    answeredAt: null,
    cancelledAt: null,
  };
  getDb().insert(pendingAsks).values(row).run();
  return row;
}

export function getPendingAskV2(id: ULID): PendingAskRowV2 | null {
  const row = getDb()
    .select()
    .from(pendingAsks)
    .where(eq(pendingAsks.id, id))
    .get();
  return row ?? null;
}

/** Open rows for a project, oldest first. Drives boot-time "you have N
 *  agents waiting on you" surfaces + Activity Panel scoping. */
export function listOpenPendingAsksV2ForProject(projectId: ULID): PendingAskRowV2[] {
  return getDb()
    .select()
    .from(pendingAsks)
    .where(and(eq(pendingAsks.projectId, projectId), eq(pendingAsks.status, 'open')))
    .orderBy(asc(pendingAsks.createdAt))
    .all();
}

/** Open rows for a CC provider session, oldest first. Used by the runtime
 *  to detect a duplicate pause for the same session (would indicate a
 *  cross-stream bug). */
export function listOpenPendingAsksV2ForSession(ccSessionId: string): PendingAskRowV2[] {
  return getDb()
    .select()
    .from(pendingAsks)
    .where(and(eq(pendingAsks.ccSessionId, ccSessionId), eq(pendingAsks.status, 'open')))
    .orderBy(asc(pendingAsks.createdAt))
    .all();
}

export interface AnswerPendingAskV2Input {
  id: ULID;
  answer: string;
  answeredBy: 'orchestrator' | 'user';
  now: number;
}

/** Atomic `open → answered` transition. Returns `true` if THIS call flipped
 *  the row, `false` if it was already terminal. Caller surfaces the false
 *  case as `already-answered` / `cancelled` / `unknown-pending-ask` to its
 *  caller. */
export function markPendingAskAnsweredV2(input: AnswerPendingAskV2Input): boolean {
  const res = getDb()
    .update(pendingAsks)
    .set({
      status: 'answered',
      answerBody: input.answer,
      answeredBy: input.answeredBy,
      answeredAt: input.now,
    })
    .where(and(eq(pendingAsks.id, input.id), eq(pendingAsks.status, 'open')))
    .run();
  return res.changes > 0;
}

/** Atomic `open → cancelled` transition. Used when the user cancels a
 *  paused agent from the Activity Panel or when the parent AgentRun is
 *  cancelled. */
export function markPendingAskCancelledV2(id: ULID, now: number): boolean {
  const res = getDb()
    .update(pendingAsks)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(eq(pendingAsks.id, id), eq(pendingAsks.status, 'open')))
    .run();
  return res.changes > 0;
}
