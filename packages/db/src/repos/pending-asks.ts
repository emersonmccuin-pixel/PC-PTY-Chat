// Section 16b — Paused-agent waits. One row per `pc_ask_orchestrator` /
// `pc_ask_user` / `pc_request_approval` call. Status field is the
// answer-once guard: orchestrator's pod prompt checks `status === 'waiting'`
// before calling `pc_answer_pending`, so JSONL-replay re-delivery of an
// already-handled event cannot double-resume the child.

import { and, asc, eq } from 'drizzle-orm';

import type {
  PendingAsk,
  PendingAskKind,
  PendingAskOption,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { pendingAsks } from '../schema.ts';

export interface CreatePendingAskInput {
  id: ULID;
  sessionId: string;
  agentName: string;
  projectId: ULID;
  runId?: ULID | null;
  parentWorkItemId?: ULID | null;
  kind: PendingAskKind;
  question: string;
  context?: string | null;
  options?: PendingAskOption[] | null;
  now: number;
}

export function createPendingAsk(input: CreatePendingAskInput): PendingAsk {
  const row = {
    id: input.id,
    sessionId: input.sessionId,
    agentName: input.agentName,
    projectId: input.projectId,
    runId: input.runId ?? null,
    parentWorkItemId: input.parentWorkItemId ?? null,
    kind: input.kind,
    question: input.question,
    context: input.context ?? null,
    options: input.options ?? null,
    status: 'waiting' as const,
    answer: null,
    answeredBy: null,
    createdAt: input.now,
    answeredAt: null,
    cancelledAt: null,
  };
  getDb().insert(pendingAsks).values(row).run();
  return row;
}

export function getPendingAsk(id: ULID): PendingAsk | null {
  const row = getDb()
    .select()
    .from(pendingAsks)
    .where(eq(pendingAsks.id, id))
    .get();
  return row ?? null;
}

/** Returns waiting rows for a project, oldest first. Drives the boot-time
 *  "you have N agents waiting on you" surface + Activity Panel scoping. */
export function listWaitingPendingAsksForProject(projectId: ULID): PendingAsk[] {
  return getDb()
    .select()
    .from(pendingAsks)
    .where(and(eq(pendingAsks.projectId, projectId), eq(pendingAsks.status, 'waiting')))
    .orderBy(asc(pendingAsks.createdAt))
    .all();
}

/** Returns waiting rows for a CC session. Used by the runtime to ensure
 *  resume doesn't race with a fresh question on the same session. */
export function listWaitingPendingAsksForSession(sessionId: string): PendingAsk[] {
  return getDb()
    .select()
    .from(pendingAsks)
    .where(and(eq(pendingAsks.sessionId, sessionId), eq(pendingAsks.status, 'waiting')))
    .orderBy(asc(pendingAsks.createdAt))
    .all();
}

export interface AnswerPendingAskInput {
  id: ULID;
  answer: string;
  answeredBy: 'orchestrator' | 'user';
  now: number;
}

/** Atomic `waiting → answered` transition. Returns `true` if the row was
 *  flipped, `false` if it was already terminal (already-answered /
 *  cancelled / missing) — caller surfaces that to its caller as the
 *  `already-answered` / `cancelled` / `unknown-pending-ask` cause. */
export function markPendingAskAnswered(input: AnswerPendingAskInput): boolean {
  const res = getDb()
    .update(pendingAsks)
    .set({
      status: 'answered',
      answer: input.answer,
      answeredBy: input.answeredBy,
      answeredAt: input.now,
    })
    .where(and(eq(pendingAsks.id, input.id), eq(pendingAsks.status, 'waiting')))
    .run();
  return res.changes > 0;
}

/** Atomic `waiting → cancelled` transition. Used when the user cancels a
 *  paused agent from the Activity Panel. */
export function markPendingAskCancelled(id: ULID, now: number): boolean {
  const res = getDb()
    .update(pendingAsks)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(eq(pendingAsks.id, id), eq(pendingAsks.status, 'waiting')))
    .run();
  return res.changes > 0;
}
