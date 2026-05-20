// Section 17a.2 — Repository layer for the pod tables.
//
// Two surfaces:
//   1. CRUD per table (agents + the three content tables). Each accepts an
//      input shape with sensible defaults; soft-delete + restore on agents,
//      hard-delete on content rows.
//   2. `getPodForSpawn(name, projectId?)` — returns the merged row bundle the
//      materialiser (17a.3) consumes. v1 = global-only; 17c upgrades the merge.
//
// All queries are live-only (`deleted_at IS NULL` for agents). Pod content
// tables don't soft-delete — they're owned by the agent and disappear when
// the user prunes a knowledge doc / secret / server.
//
// Audit-on-mutate is NOT in this file. 17a.4 layers it on top via the
// `agent_audit` table; this repo intentionally stays pure CRUD.

import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  AgentEffort,
  AgentModel,
  AgentOutputDestination,
  PodAgentRow,
  PodKnowledgeKind,
  PodKnowledgeRow,
  PodMcpServerConfig,
  PodMcpServerRow,
  PodScope,
  PodSecretRow,
  ULID,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { agentKnowledge, agentMcpServers, agentSecrets, agents } from '../schema.ts';

// --- agents -----------------------------------------------------------------

export interface CreateAgentInput {
  /** Optional pre-minted ULID — useful when an upstream flow needs to reference
   *  the new id before insert (e.g. materialising children in the same tx). */
  id?: ULID;
  name: string;
  scope: PodScope;
  /** Required when `scope === 'project'`; ignored otherwise. */
  projectId?: ULID | null;
  prompt?: string;
  tools?: string[];
  model?: AgentModel | null;
  effort?: AgentEffort | null;
  maxTurns?: number | null;
  outputDestination?: AgentOutputDestination | null;
  description?: string;
}

function rowToAgent(row: typeof agents.$inferSelect): PodAgentRow {
  return {
    id: row.id as ULID,
    name: row.name,
    scope: row.scope,
    projectId: row.projectId ?? null,
    prompt: row.prompt,
    tools: row.tools,
    model: row.model ?? null,
    effort: row.effort ?? null,
    maxTurns: row.maxTurns ?? null,
    outputDestination: row.outputDestination ?? null,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

export function createAgent(input: CreateAgentInput): PodAgentRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createAgent: projectId is required when scope === "project"');
  }
  const now = Date.now();
  const id = input.id ?? newId();
  const row = {
    id,
    name: input.name,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId ?? null : null,
    prompt: input.prompt ?? '',
    tools: input.tools ?? [],
    model: input.model ?? null,
    effort: input.effort ?? null,
    maxTurns: input.maxTurns ?? null,
    outputDestination: input.outputDestination ?? null,
    description: input.description ?? '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  getDb().insert(agents).values(row).run();
  return rowToAgent(row as typeof agents.$inferSelect);
}

export function getAgentById(id: ULID): PodAgentRow | null {
  const row = getDb()
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), isNull(agents.deletedAt)))
    .get();
  return row ? rowToAgent(row) : null;
}

export interface GetAgentByNameInput {
  name: string;
  scope: PodScope;
  /** Required when `scope === 'project'`. */
  projectId?: ULID | null;
}

export function getAgentByName(input: GetAgentByNameInput): PodAgentRow | null {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('getAgentByName: projectId is required when scope === "project"');
  }
  const projectCmp =
    input.scope === 'project'
      ? eq(agents.projectId, input.projectId!)
      : isNull(agents.projectId);
  const row = getDb()
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.name, input.name),
        eq(agents.scope, input.scope),
        projectCmp,
        isNull(agents.deletedAt),
      ),
    )
    .get();
  return row ? rowToAgent(row) : null;
}

export interface ListAgentsOptions {
  scope?: PodScope;
  /** When set, narrows to project-scope rows for this project. Implies
   *  `scope: 'project'`. */
  projectId?: ULID;
}

export function listAgents(opts: ListAgentsOptions = {}): PodAgentRow[] {
  const conditions = [isNull(agents.deletedAt)];
  if (opts.projectId !== undefined) {
    conditions.push(eq(agents.scope, 'project'));
    conditions.push(eq(agents.projectId, opts.projectId));
  } else if (opts.scope !== undefined) {
    conditions.push(eq(agents.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(agents)
    .where(and(...conditions))
    .orderBy(asc(agents.name))
    .all();
  return rows.map(rowToAgent);
}

export interface UpdateAgentInput {
  name?: string;
  prompt?: string;
  tools?: string[];
  model?: AgentModel | null;
  effort?: AgentEffort | null;
  maxTurns?: number | null;
  outputDestination?: AgentOutputDestination | null;
  description?: string;
}

export function updateAgent(id: ULID, patch: UpdateAgentInput): PodAgentRow | null {
  const existing = getAgentById(id);
  if (!existing) return null;
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.prompt !== undefined) set.prompt = patch.prompt;
  if (patch.tools !== undefined) set.tools = patch.tools;
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.effort !== undefined) set.effort = patch.effort;
  if (patch.maxTurns !== undefined) set.maxTurns = patch.maxTurns;
  if (patch.outputDestination !== undefined) set.outputDestination = patch.outputDestination;
  if (patch.description !== undefined) set.description = patch.description;
  getDb().update(agents).set(set).where(eq(agents.id, id)).run();
  return getAgentById(id);
}

/** Flip `deleted_at`. Idempotent — returns the (now-deleted) row if it
 *  existed live, or null if no such id was live to begin with. */
export function softDeleteAgent(id: ULID): PodAgentRow | null {
  const existing = getAgentById(id);
  if (!existing) return null;
  const now = Date.now();
  getDb().update(agents).set({ deletedAt: now, updatedAt: now }).where(eq(agents.id, id)).run();
  return { ...existing, deletedAt: now, updatedAt: now };
}

/** Clear `deleted_at`. Returns the restored row, or null if no such id (or
 *  not currently deleted). */
export function restoreAgent(id: ULID): PodAgentRow | null {
  const row = getDb().select().from(agents).where(eq(agents.id, id)).get();
  if (!row || row.deletedAt === null) return null;
  const now = Date.now();
  getDb().update(agents).set({ deletedAt: null, updatedAt: now }).where(eq(agents.id, id)).run();
  return getAgentById(id);
}

// --- agent_knowledge --------------------------------------------------------

export interface CreateKnowledgeInput {
  id?: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  name: string;
  kind?: PodKnowledgeKind;
  content?: string;
}

function rowToKnowledge(row: typeof agentKnowledge.$inferSelect): PodKnowledgeRow {
  return {
    id: row.id as ULID,
    agentId: row.agentId as ULID,
    scope: row.scope,
    projectId: row.projectId ?? null,
    name: row.name,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createKnowledge(input: CreateKnowledgeInput): PodKnowledgeRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createKnowledge: projectId is required when scope === "project"');
  }
  const now = Date.now();
  const id = input.id ?? newId();
  const row = {
    id,
    agentId: input.agentId,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId ?? null : null,
    name: input.name,
    kind: input.kind ?? 'knowledge',
    content: input.content ?? '',
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(agentKnowledge).values(row).run();
  return rowToKnowledge(row as typeof agentKnowledge.$inferSelect);
}

export function getKnowledge(id: ULID): PodKnowledgeRow | null {
  const row = getDb()
    .select()
    .from(agentKnowledge)
    .where(eq(agentKnowledge.id, id))
    .get();
  return row ? rowToKnowledge(row) : null;
}

export interface GetKnowledgeByNameInput {
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  name: string;
}

export function getKnowledgeByName(input: GetKnowledgeByNameInput): PodKnowledgeRow | null {
  const projectCmp =
    input.scope === 'project'
      ? eq(agentKnowledge.projectId, input.projectId!)
      : isNull(agentKnowledge.projectId);
  const row = getDb()
    .select()
    .from(agentKnowledge)
    .where(
      and(
        eq(agentKnowledge.agentId, input.agentId),
        eq(agentKnowledge.scope, input.scope),
        projectCmp,
        eq(agentKnowledge.name, input.name),
      ),
    )
    .get();
  return row ? rowToKnowledge(row) : null;
}

export interface ListKnowledgeOptions {
  agentId: ULID;
  scope?: PodScope;
  projectId?: ULID;
}

export function listKnowledge(opts: ListKnowledgeOptions): PodKnowledgeRow[] {
  const conditions = [eq(agentKnowledge.agentId, opts.agentId)];
  if (opts.projectId !== undefined) {
    conditions.push(eq(agentKnowledge.scope, 'project'));
    conditions.push(eq(agentKnowledge.projectId, opts.projectId));
  } else if (opts.scope !== undefined) {
    conditions.push(eq(agentKnowledge.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(agentKnowledge)
    .where(and(...conditions))
    .orderBy(asc(agentKnowledge.name))
    .all();
  return rows.map(rowToKnowledge);
}

export interface UpdateKnowledgeInput {
  name?: string;
  kind?: PodKnowledgeKind;
  content?: string;
}

export function updateKnowledge(id: ULID, patch: UpdateKnowledgeInput): PodKnowledgeRow | null {
  const existing = getKnowledge(id);
  if (!existing) return null;
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.content !== undefined) set.content = patch.content;
  getDb().update(agentKnowledge).set(set).where(eq(agentKnowledge.id, id)).run();
  return getKnowledge(id);
}

export function deleteKnowledge(id: ULID): boolean {
  const result = getDb().delete(agentKnowledge).where(eq(agentKnowledge.id, id)).run();
  return (result.changes ?? 0) > 0;
}

// --- agent_secrets ----------------------------------------------------------

export interface CreateSecretInput {
  id?: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  envVarName: string;
  valuePlaintext: string;
}

function rowToSecret(row: typeof agentSecrets.$inferSelect): PodSecretRow {
  return {
    id: row.id as ULID,
    agentId: row.agentId as ULID,
    scope: row.scope,
    projectId: row.projectId ?? null,
    envVarName: row.envVarName,
    valuePlaintext: row.valuePlaintext,
    createdAt: row.createdAt,
  };
}

export function createSecret(input: CreateSecretInput): PodSecretRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createSecret: projectId is required when scope === "project"');
  }
  const id = input.id ?? newId();
  const row = {
    id,
    agentId: input.agentId,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId ?? null : null,
    envVarName: input.envVarName,
    valuePlaintext: input.valuePlaintext,
    createdAt: Date.now(),
  };
  getDb().insert(agentSecrets).values(row).run();
  return rowToSecret(row as typeof agentSecrets.$inferSelect);
}

export function getSecret(id: ULID): PodSecretRow | null {
  const row = getDb().select().from(agentSecrets).where(eq(agentSecrets.id, id)).get();
  return row ? rowToSecret(row) : null;
}

export interface GetSecretByEnvInput {
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  envVarName: string;
}

export function getSecretByEnvVarName(input: GetSecretByEnvInput): PodSecretRow | null {
  const projectCmp =
    input.scope === 'project'
      ? eq(agentSecrets.projectId, input.projectId!)
      : isNull(agentSecrets.projectId);
  const row = getDb()
    .select()
    .from(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentId, input.agentId),
        eq(agentSecrets.scope, input.scope),
        projectCmp,
        eq(agentSecrets.envVarName, input.envVarName),
      ),
    )
    .get();
  return row ? rowToSecret(row) : null;
}

export interface ListSecretsOptions {
  agentId: ULID;
  scope?: PodScope;
  projectId?: ULID;
}

export function listSecrets(opts: ListSecretsOptions): PodSecretRow[] {
  const conditions = [eq(agentSecrets.agentId, opts.agentId)];
  if (opts.projectId !== undefined) {
    conditions.push(eq(agentSecrets.scope, 'project'));
    conditions.push(eq(agentSecrets.projectId, opts.projectId));
  } else if (opts.scope !== undefined) {
    conditions.push(eq(agentSecrets.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(agentSecrets)
    .where(and(...conditions))
    .orderBy(asc(agentSecrets.envVarName))
    .all();
  return rows.map(rowToSecret);
}

export function deleteSecret(id: ULID): boolean {
  const result = getDb().delete(agentSecrets).where(eq(agentSecrets.id, id)).run();
  return (result.changes ?? 0) > 0;
}

// --- agent_mcp_servers ------------------------------------------------------

export interface CreateMcpServerInput {
  id?: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  name: string;
  config: PodMcpServerConfig;
}

function rowToMcpServer(row: typeof agentMcpServers.$inferSelect): PodMcpServerRow {
  return {
    id: row.id as ULID,
    agentId: row.agentId as ULID,
    scope: row.scope,
    projectId: row.projectId ?? null,
    name: row.name,
    config: row.config,
    createdAt: row.createdAt,
  };
}

export function createMcpServer(input: CreateMcpServerInput): PodMcpServerRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createMcpServer: projectId is required when scope === "project"');
  }
  const id = input.id ?? newId();
  const row = {
    id,
    agentId: input.agentId,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId ?? null : null,
    name: input.name,
    config: input.config,
    createdAt: Date.now(),
  };
  getDb().insert(agentMcpServers).values(row).run();
  return rowToMcpServer(row as typeof agentMcpServers.$inferSelect);
}

export function getMcpServer(id: ULID): PodMcpServerRow | null {
  const row = getDb().select().from(agentMcpServers).where(eq(agentMcpServers.id, id)).get();
  return row ? rowToMcpServer(row) : null;
}

export interface GetMcpServerByNameInput {
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  name: string;
}

export function getMcpServerByName(input: GetMcpServerByNameInput): PodMcpServerRow | null {
  const projectCmp =
    input.scope === 'project'
      ? eq(agentMcpServers.projectId, input.projectId!)
      : isNull(agentMcpServers.projectId);
  const row = getDb()
    .select()
    .from(agentMcpServers)
    .where(
      and(
        eq(agentMcpServers.agentId, input.agentId),
        eq(agentMcpServers.scope, input.scope),
        projectCmp,
        eq(agentMcpServers.name, input.name),
      ),
    )
    .get();
  return row ? rowToMcpServer(row) : null;
}

export interface ListMcpServersOptions {
  agentId: ULID;
  scope?: PodScope;
  projectId?: ULID;
}

export function listMcpServers(opts: ListMcpServersOptions): PodMcpServerRow[] {
  const conditions = [eq(agentMcpServers.agentId, opts.agentId)];
  if (opts.projectId !== undefined) {
    conditions.push(eq(agentMcpServers.scope, 'project'));
    conditions.push(eq(agentMcpServers.projectId, opts.projectId));
  } else if (opts.scope !== undefined) {
    conditions.push(eq(agentMcpServers.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(agentMcpServers)
    .where(and(...conditions))
    .orderBy(asc(agentMcpServers.name))
    .all();
  return rows.map(rowToMcpServer);
}

export function deleteMcpServer(id: ULID): boolean {
  const result = getDb().delete(agentMcpServers).where(eq(agentMcpServers.id, id)).run();
  return (result.changes ?? 0) > 0;
}

// --- pod bundle -------------------------------------------------------------

export interface PodSpawnBundle {
  agent: PodAgentRow;
  knowledge: PodKnowledgeRow[];
  secrets: PodSecretRow[];
  mcpServers: PodMcpServerRow[];
}

/** Read the full pod the materialiser (17a.3) needs to render `.md` +
 *  `mcp.json` + env vars at spawn time.
 *
 *  v1 = global-only. Resolution looks up the live global agent by `name`
 *  and returns its global-scope content rows. `projectId` is accepted for
 *  forward-compat — 17c will overlay the project rows onto the global ones
 *  (concatenate knowledge; project wins per env-var-name + per server-name).
 *
 *  Returns null when no live global agent with that name exists.
 */
export function getPodForSpawn(name: string, _projectId?: ULID): PodSpawnBundle | null {
  const agent = getAgentByName({ name, scope: 'global' });
  if (!agent) return null;
  return {
    agent,
    knowledge: listKnowledge({ agentId: agent.id, scope: 'global' }),
    secrets: listSecrets({ agentId: agent.id, scope: 'global' }),
    mcpServers: listMcpServers({ agentId: agent.id, scope: 'global' }),
  };
}
