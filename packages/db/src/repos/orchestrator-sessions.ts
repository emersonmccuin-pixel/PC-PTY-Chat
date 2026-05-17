// OrchestratorSession repo. One active row per project (DB-enforced via
// `orch_sessions_active_per_project_idx`). `providerSessionId` is Claude's
// session UUID — minted by us at create time and passed via `--session-id`,
// then reused via `--resume` on subsequent spawns so chat history matches
// what Claude actually has in context.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  OrchestratorSession,
  ProviderId,
  SessionEndedReason,
  ULID,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { orchestratorSessions } from '../schema.ts';

interface SessionRow {
  id: ULID;
  projectId: ULID;
  provider: ProviderId;
  providerSessionId: string | null;
  model: string | null;
  title: string | null;
  status: 'active' | 'ended';
  endedReason: SessionEndedReason | null;
  startedAt: number;
  endedAt: number | null;
  deletedAt: number | null;
}

function toDomain(row: SessionRow): OrchestratorSession {
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    model: row.model,
    title: row.title,
    status: row.status,
    endedReason: row.endedReason,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    deletedAt: row.deletedAt,
  };
}

export interface CreateOrchestratorSessionInput {
  projectId: ULID;
  /** Claude session UUID. We mint it ourselves so we can pass `--session-id`
   *  on first spawn and write the row before any hook fires. */
  providerSessionId: string;
  provider?: ProviderId;
  model?: string | null;
  title?: string | null;
}

export function createOrchestratorSession(
  input: CreateOrchestratorSessionInput,
): OrchestratorSession {
  const now = Date.now();
  const id = newId();
  getDb()
    .insert(orchestratorSessions)
    .values({
      id,
      projectId: input.projectId,
      provider: input.provider ?? 'claude',
      providerSessionId: input.providerSessionId,
      model: input.model ?? null,
      title: input.title ?? null,
      status: 'active',
      startedAt: now,
    })
    .run();
  return {
    id,
    projectId: input.projectId,
    provider: input.provider ?? 'claude',
    providerSessionId: input.providerSessionId,
    model: input.model ?? null,
    title: input.title ?? null,
    status: 'active',
    endedReason: null,
    startedAt: now,
    endedAt: null,
    deletedAt: null,
  };
}

export function getActiveOrchestratorSession(projectId: ULID): OrchestratorSession | null {
  const row = getDb()
    .select()
    .from(orchestratorSessions)
    .where(
      and(
        eq(orchestratorSessions.projectId, projectId),
        eq(orchestratorSessions.status, 'active'),
        isNull(orchestratorSessions.deletedAt),
      ),
    )
    .get() as SessionRow | undefined;
  return row ? toDomain(row) : null;
}

export function listOrchestratorSessionsForProject(
  projectId: ULID,
): OrchestratorSession[] {
  const rows = getDb()
    .select()
    .from(orchestratorSessions)
    .where(
      and(
        eq(orchestratorSessions.projectId, projectId),
        isNull(orchestratorSessions.deletedAt),
      ),
    )
    .orderBy(desc(orchestratorSessions.startedAt))
    .all() as SessionRow[];
  return rows.map(toDomain);
}

export function endOrchestratorSession(
  id: ULID,
  reason: SessionEndedReason,
): OrchestratorSession | null {
  const now = Date.now();
  getDb()
    .update(orchestratorSessions)
    .set({ status: 'ended', endedReason: reason, endedAt: now })
    .where(eq(orchestratorSessions.id, id))
    .run();
  const row = getDb()
    .select()
    .from(orchestratorSessions)
    .where(eq(orchestratorSessions.id, id))
    .get() as SessionRow | undefined;
  return row ? toDomain(row) : null;
}

/** Set or update the title. Caller decides when (first user message today). */
export function setOrchestratorSessionTitle(id: ULID, title: string): void {
  getDb()
    .update(orchestratorSessions)
    .set({ title })
    .where(eq(orchestratorSessions.id, id))
    .run();
}
