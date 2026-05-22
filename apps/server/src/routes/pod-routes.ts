// Section 17d.1 — HTTP routes for the pod tables.
//
// Mounted on the main Hono app via registerPodRoutes(); also imported by
// pod-routes.test.ts so the tests exercise the same handler code paths the
// production server runs.
//
// v1 = global-scope only. Routes reject `scope: 'project'` payloads with 400
// (the repo also rejects, but routes do it first so we never partially
// transact on a bad input).
//
// Mutating routes emit two effects after the DB write:
//   1. `deps.broadcastAll({ type: 'pod-changed', ... })` — global broadcast
//      so every connected project's WS picks it up (pods are global-scope).
//   2. `deps.onPodChanged?.(name, change)` — optional restart-on-edit hook
//      (17d.10). The default test wiring omits it; production wires the
//      agent-run-manager + project-runtime kill+respawn paths.
//
// Secrets never leak values over the wire: GET /:id strips `valuePlaintext`
// from secret rows; the secret create body accepts the value but it goes
// straight into the DB and is never read back through the routes.

import type { Hono } from 'hono';
import {
  createAgent,
  createKnowledge,
  createMcpServer,
  createSecret,
  deleteKnowledge,
  deleteMcpServer,
  deleteSecret,
  getAgentById,
  getKnowledge,
  getMcpServer,
  getSecret,
  listAgentAudit,
  listAgents,
  listKnowledge,
  listMcpServers,
  listSecrets,
  softDeleteAgent,
  updateAgent,
  updateKnowledge,
} from '@pc/db';
import type {
  AgentEffort,
  AgentModel,
  AgentOutputDestination,
  PodAgentRow,
  PodAuditActor,
  PodAuditField,
  PodKnowledgeKind,
  PodKnowledgeRow,
  PodMcpServerConfig,
  PodMcpServerRow,
  PodSecretRow,
  ULID,
} from '@pc/domain';
import { POD_AUDIT_ACTORS, POD_AUDIT_FIELDS, POD_KNOWLEDGE_KINDS } from '@pc/domain';

/** Stock pods seeded at boot — deleting them is structurally disallowed
 *  (DELETE returns 409). Editing is fine; the user can rewrite the prompt. */
export const STOCK_POD_NAMES = new Set([
  'orchestrator',
  'researcher',
  'writer',
  'reviewer',
  'planner',
  'extractor',
]);

export type PodMutationKind = 'created' | 'updated' | 'deleted';

export interface PodRoutesDeps {
  /** Broadcast to every connected project's WS. Pods are global; consumers
   *  filter by `type` rather than by `projectId`. Helper added to index.ts
   *  alongside `broadcastTo` in 17d.1. */
  broadcastAll: (msg: unknown) => void;
  /** Optional restart-on-edit hook (17d.10). Called after every successful
   *  pod mutation lands its broadcast. Receives the pod's name + change
   *  kind so the caller can decide whether to kill+respawn anything. */
  onPodChanged?: (podName: string, change: PodMutationKind) => void;
}

/** Public projection of a secret — `valuePlaintext` is stripped. Never sent
 *  back through any read path. */
export interface PublicPodSecret {
  id: ULID;
  agentId: ULID;
  envVarName: string;
  createdAt: number;
}

function publicSecret(row: PodSecretRow): PublicPodSecret {
  return {
    id: row.id,
    agentId: row.agentId,
    envVarName: row.envVarName,
    createdAt: row.createdAt,
  };
}

export interface PodBundle {
  agent: PodAgentRow;
  knowledge: PodKnowledgeRow[];
  secrets: PublicPodSecret[];
  mcpServers: PodMcpServerRow[];
}

/** Assemble the full bundle for the modal mount. Lives next to the routes so
 *  the test can call it directly. */
export function getPodBundle(agentId: ULID): PodBundle | null {
  const agent = getAgentById(agentId);
  if (!agent) return null;
  return {
    agent,
    knowledge: listKnowledge({ agentId: agent.id, scope: agent.scope }),
    secrets: listSecrets({ agentId: agent.id, scope: agent.scope }).map(publicSecret),
    mcpServers: listMcpServers({ agentId: agent.id, scope: agent.scope }),
  };
}

/** Effort + audit-field + audit-actor + knowledge-kind validators. Routes
 *  use these to reject unknown enum strings before hitting the repo. */
const KNOWN_EFFORTS: ReadonlySet<AgentEffort> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function asEffortOrNull(v: unknown): AgentEffort | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string' && KNOWN_EFFORTS.has(v as AgentEffort)) {
    return v as AgentEffort;
  }
  throw new Error(`invalid effort: ${JSON.stringify(v)}`);
}

function asModelOrNull(v: unknown): AgentModel | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string' && v.length > 0) return v as AgentModel;
  throw new Error(`invalid model: ${JSON.stringify(v)}`);
}

function asMaxTurnsOrNull(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  throw new Error(`invalid maxTurns: ${JSON.stringify(v)}`);
}

function asToolsArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    return v as string[];
  }
  throw new Error(`invalid tools: expected string[]`);
}

function asOutputDestinationOrNull(v: unknown): AgentOutputDestination | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string' && v.length > 0) {
    return v as AgentOutputDestination;
  }
  throw new Error(`invalid outputDestination: ${JSON.stringify(v)}`);
}

function asActor(v: unknown): PodAuditActor | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (POD_AUDIT_ACTORS as readonly string[]).includes(v)) {
    return v as PodAuditActor;
  }
  throw new Error(`invalid actor: ${JSON.stringify(v)}`);
}

function asAuditField(v: unknown): PodAuditField | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (POD_AUDIT_FIELDS as readonly string[]).includes(v)) {
    return v as PodAuditField;
  }
  throw new Error(`invalid field: ${JSON.stringify(v)}`);
}

function asKnowledgeKind(v: unknown): PodKnowledgeKind | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string' && (POD_KNOWLEDGE_KINDS as readonly string[]).includes(v)) {
    return v as PodKnowledgeKind;
  }
  throw new Error(`invalid kind: ${JSON.stringify(v)}`);
}

function asMcpConfig(v: unknown): PodMcpServerConfig {
  if (!v || typeof v !== 'object') {
    throw new Error('mcp server config must be an object');
  }
  const cfg = v as Record<string, unknown>;
  const out: PodMcpServerConfig = {};
  if (cfg.command !== undefined) {
    if (typeof cfg.command !== 'string') throw new Error('mcp.command must be a string');
    out.command = cfg.command;
  }
  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args) || !cfg.args.every((a) => typeof a === 'string')) {
      throw new Error('mcp.args must be string[]');
    }
    out.args = cfg.args as string[];
  }
  if (cfg.env !== undefined) {
    if (!cfg.env || typeof cfg.env !== 'object' || Array.isArray(cfg.env)) {
      throw new Error('mcp.env must be an object of string=string');
    }
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(cfg.env as Record<string, unknown>)) {
      if (typeof val !== 'string') throw new Error(`mcp.env.${k} must be a string`);
      env[k] = val;
    }
    out.env = env;
  }
  if (cfg.url !== undefined) {
    if (typeof cfg.url !== 'string') throw new Error('mcp.url must be a string');
    out.url = cfg.url;
  }
  return out;
}

/** Register every pod route on `app`. Idempotent — call once per Hono
 *  instance. */
export function registerPodRoutes(app: Hono, deps: PodRoutesDeps): void {
  // --- /api/agents/pods ---------------------------------------------------

  /** List all live pods. v1 = global-scope only. */
  app.get('/api/agents/pods', (c) => {
    const pods = listAgents({ scope: 'global' });
    return c.json({ ok: true, pods });
  });

  /** Full bundle for the detail modal: agent row + knowledge + secret
   *  metadata (no values) + mcp servers. */
  app.get('/api/agents/pods/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const bundle = getPodBundle(id);
    if (!bundle) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    return c.json({ ok: true, ...bundle });
  });

  /** Audit log for a pod. Filters: actor, field, beforeCreatedAt, limit. */
  app.get('/api/agents/pods/:id/audit', (c) => {
    const id = c.req.param('id') as ULID;
    if (!getAgentById(id)) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    try {
      const actor = asActor(c.req.query('actor'));
      const field = asAuditField(c.req.query('field'));
      const limitRaw = c.req.query('limit');
      const beforeRaw = c.req.query('beforeCreatedAt');
      const limit = limitRaw ? Number(limitRaw) : undefined;
      const beforeCreatedAt = beforeRaw ? Number(beforeRaw) : undefined;
      if (limit !== undefined && !(Number.isFinite(limit) && limit > 0)) {
        return c.json({ ok: false, error: 'invalid limit' }, 400);
      }
      if (beforeCreatedAt !== undefined && !Number.isFinite(beforeCreatedAt)) {
        return c.json({ ok: false, error: 'invalid beforeCreatedAt' }, 400);
      }
      const rows = listAgentAudit({
        agentId: id,
        ...(limit !== undefined ? { limit } : {}),
        ...(beforeCreatedAt !== undefined ? { beforeCreatedAt } : {}),
        ...(actor !== undefined ? { actor } : {}),
        ...(field !== undefined ? { field } : {}),
      });
      return c.json({ ok: true, rows });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  /** Create a new pod. v1 = global-scope only. Body: name + optional fields. */
  app.post('/api/agents/pods', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ ok: false, error: 'name required' }, 400);
    if (body.scope !== undefined && body.scope !== 'global') {
      return c.json({ ok: false, error: 'only scope="global" is supported in v1' }, 400);
    }
    let row: PodAgentRow;
    try {
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      const description = typeof body.description === 'string' ? body.description : '';
      row = createAgent(
        {
          name,
          scope: 'global',
          prompt,
          description,
          ...(body.model !== undefined ? { model: asModelOrNull(body.model) ?? null } : {}),
          ...(body.effort !== undefined ? { effort: asEffortOrNull(body.effort) ?? null } : {}),
          ...(body.maxTurns !== undefined
            ? { maxTurns: asMaxTurnsOrNull(body.maxTurns) ?? null }
            : {}),
          ...(body.tools !== undefined ? { tools: asToolsArray(body.tools) ?? [] } : {}),
          ...(body.outputDestination !== undefined
            ? { outputDestination: asOutputDestinationOrNull(body.outputDestination) ?? null }
            : {}),
        },
        { actor: 'user', reason: 'ui-create' },
      );
    } catch (err) {
      const msg = (err as Error).message;
      const status = /required|invalid|UNIQUE/i.test(msg) ? 400 : 500;
      return c.json({ ok: false, error: msg }, status);
    }
    deps.broadcastAll({ type: 'pod-changed', change: 'created', pod: row });
    deps.onPodChanged?.(row.name, 'created');
    return c.json({ ok: true, pod: row }, 201);
  });

  /** Patch a pod's scalar fields. Multi-field updates audit under a shared
   *  change-set (handled by the repo). Returns the post-update row. */
  app.patch('/api/agents/pods/:id', async (c) => {
    const id = c.req.param('id') as ULID;
    const existing = getAgentById(id);
    if (!existing) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    let updated: PodAgentRow | null;
    try {
      const patch: Parameters<typeof updateAgent>[1] = {};
      if (typeof body.name === 'string') patch.name = body.name.trim();
      if (typeof body.prompt === 'string') patch.prompt = body.prompt;
      if (typeof body.description === 'string') patch.description = body.description;
      if (body.tools !== undefined) {
        const tools = asToolsArray(body.tools);
        if (tools !== undefined) patch.tools = tools;
      }
      if (body.model !== undefined) patch.model = asModelOrNull(body.model) ?? null;
      if (body.effort !== undefined) patch.effort = asEffortOrNull(body.effort) ?? null;
      if (body.maxTurns !== undefined) patch.maxTurns = asMaxTurnsOrNull(body.maxTurns) ?? null;
      if (body.outputDestination !== undefined) {
        patch.outputDestination = asOutputDestinationOrNull(body.outputDestination) ?? null;
      }
      if (patch.name === '') {
        return c.json({ ok: false, error: 'name cannot be empty' }, 400);
      }
      updated = updateAgent(id, patch, { actor: 'user', reason: 'ui-edit' });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    if (!updated) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    deps.broadcastAll({ type: 'pod-changed', change: 'updated', pod: updated });
    deps.onPodChanged?.(updated.name, 'updated');
    return c.json({ ok: true, pod: updated });
  });

  /** Soft-delete a pod. Stock specialists are 409 (their names live in
   *  STOCK_POD_NAMES; deleting them would orphan running CC sessions that
   *  depend on the seeded shape). */
  app.delete('/api/agents/pods/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const existing = getAgentById(id);
    if (!existing) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    if (STOCK_POD_NAMES.has(existing.name)) {
      return c.json(
        {
          ok: false,
          error: `Stock specialists can't be deleted. Edit the prompt instead.`,
          kind: 'stock-specialist' as const,
        },
        409,
      );
    }
    const deleted = softDeleteAgent(id, { actor: 'user', reason: 'ui-delete' });
    if (!deleted) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    deps.broadcastAll({ type: 'pod-changed', change: 'deleted', podId: id, name: existing.name });
    deps.onPodChanged?.(existing.name, 'deleted');
    return c.json({ ok: true });
  });

  // --- knowledge ----------------------------------------------------------

  app.post('/api/agents/pods/:id/knowledge', async (c) => {
    const id = c.req.param('id') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ ok: false, error: 'name required' }, 400);
    let row: PodKnowledgeRow;
    try {
      row = createKnowledge(
        {
          agentId: id,
          scope: 'global',
          name,
          ...(body.kind !== undefined ? { kind: asKnowledgeKind(body.kind) } : {}),
          content: typeof body.content === 'string' ? body.content : '',
        },
        { actor: 'user', reason: 'ui-create-knowledge' },
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    deps.broadcastAll({ type: 'pod-changed', change: 'updated', podId: id, name: agent.name });
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true, knowledge: row }, 201);
  });

  app.patch('/api/agents/pods/:id/knowledge/:knowledgeId', async (c) => {
    const id = c.req.param('id') as ULID;
    const knowledgeId = c.req.param('knowledgeId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const existing = getKnowledge(knowledgeId);
    if (!existing || existing.agentId !== id) {
      return c.json({ ok: false, error: `unknown knowledge: ${knowledgeId}` }, 404);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    let updated: PodKnowledgeRow | null;
    try {
      const patch: Parameters<typeof updateKnowledge>[1] = {};
      if (typeof body.name === 'string') patch.name = body.name.trim();
      if (typeof body.content === 'string') patch.content = body.content;
      if (body.kind !== undefined) {
        const kind = asKnowledgeKind(body.kind);
        if (kind !== undefined) patch.kind = kind;
      }
      updated = updateKnowledge(knowledgeId, patch, {
        actor: 'user',
        reason: 'ui-edit-knowledge',
      });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    if (!updated) return c.json({ ok: false, error: `unknown knowledge: ${knowledgeId}` }, 404);
    deps.broadcastAll({ type: 'pod-changed', change: 'updated', podId: id, name: agent.name });
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true, knowledge: updated });
  });

  app.delete('/api/agents/pods/:id/knowledge/:knowledgeId', (c) => {
    const id = c.req.param('id') as ULID;
    const knowledgeId = c.req.param('knowledgeId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const existing = getKnowledge(knowledgeId);
    if (!existing || existing.agentId !== id) {
      return c.json({ ok: false, error: `unknown knowledge: ${knowledgeId}` }, 404);
    }
    const removed = deleteKnowledge(knowledgeId, {
      actor: 'user',
      reason: 'ui-delete-knowledge',
    });
    if (!removed) return c.json({ ok: false, error: `unknown knowledge: ${knowledgeId}` }, 404);
    deps.broadcastAll({ type: 'pod-changed', change: 'updated', podId: id, name: agent.name });
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true });
  });

  // --- secrets ------------------------------------------------------------

  app.post('/api/agents/pods/:id/secrets', async (c) => {
    const id = c.req.param('id') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const envVarName = typeof body.envVarName === 'string' ? body.envVarName.trim() : '';
    const valuePlaintext = typeof body.valuePlaintext === 'string' ? body.valuePlaintext : '';
    if (!envVarName) {
      return c.json({ ok: false, error: 'envVarName required' }, 400);
    }
    let row: PodSecretRow;
    try {
      row = createSecret(
        { agentId: id, scope: 'global', envVarName, valuePlaintext },
        { actor: 'user', reason: 'ui-create-secret' },
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    deps.broadcastAll({ type: 'pod-changed', change: 'updated', podId: id, name: agent.name });
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true, secret: publicSecret(row) }, 201);
  });

  app.delete('/api/agents/pods/:id/secrets/:secretId', (c) => {
    const id = c.req.param('id') as ULID;
    const secretId = c.req.param('secretId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const existing = getSecret(secretId);
    if (!existing || existing.agentId !== id) {
      return c.json({ ok: false, error: `unknown secret: ${secretId}` }, 404);
    }
    const removed = deleteSecret(secretId, { actor: 'user', reason: 'ui-delete-secret' });
    if (!removed) return c.json({ ok: false, error: `unknown secret: ${secretId}` }, 404);
    deps.broadcastAll({ type: 'pod-changed', change: 'updated', podId: id, name: agent.name });
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true });
  });

  // --- mcp servers --------------------------------------------------------

  app.post('/api/agents/pods/:id/mcp-servers', async (c) => {
    const id = c.req.param('id') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ ok: false, error: 'name required' }, 400);
    let row: PodMcpServerRow;
    try {
      const config = asMcpConfig(body.config);
      row = createMcpServer(
        { agentId: id, scope: 'global', name, config },
        { actor: 'user', reason: 'ui-create-mcp' },
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    deps.broadcastAll({ type: 'pod-changed', change: 'updated', podId: id, name: agent.name });
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true, mcpServer: row }, 201);
  });

  app.delete('/api/agents/pods/:id/mcp-servers/:mcpId', (c) => {
    const id = c.req.param('id') as ULID;
    const mcpId = c.req.param('mcpId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const existing = getMcpServer(mcpId);
    if (!existing || existing.agentId !== id) {
      return c.json({ ok: false, error: `unknown mcp server: ${mcpId}` }, 404);
    }
    const removed = deleteMcpServer(mcpId, { actor: 'user', reason: 'ui-delete-mcp' });
    if (!removed) return c.json({ ok: false, error: `unknown mcp server: ${mcpId}` }, 404);
    deps.broadcastAll({ type: 'pod-changed', change: 'updated', podId: id, name: agent.name });
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true });
  });
}
