import type { Hono } from 'hono';
import type { StatuslineSnapshot, ULID } from '@pc/domain';
import {
  getLatestSnapshotForProject as defaultGetLatestSnapshotForProject,
  insertStatuslineSnapshot as defaultInsertStatuslineSnapshot,
  listLatestSnapshotPerSession as defaultListLatestSnapshotPerSession,
  newId as defaultNewId,
  type InsertStatuslineSnapshotInput,
  type StatuslineSnapshotRow,
} from '@pc/db';

type UsageBucket = 'day' | 'week' | 'month';
type UsageAggregateRow = Pick<
  StatuslineSnapshotRow,
  | 'pcSessionId'
  | 'projectId'
  | 'receivedAt'
  | 'totalCostUsd'
  | 'modelId'
  | 'totalInputTokens'
  | 'totalOutputTokens'
>;

export interface StatuslineRouteDeps {
  broadcastTo(projectId: ULID, msg: unknown): void;
  now?: () => number;
  newId?: () => ULID;
  insertStatuslineSnapshot?: (input: InsertStatuslineSnapshotInput) => void;
  listLatestSnapshotPerSession?: (sinceMs: number) => UsageAggregateRow[];
  getLatestSnapshotForProject?: (projectId: ULID) => StatuslineSnapshotRow | null;
}

export function registerStatuslineRoutes(app: Hono, deps: StatuslineRouteDeps): void {
  const services = {
    now: deps.now ?? Date.now,
    newId: deps.newId ?? defaultNewId,
    insertStatuslineSnapshot: deps.insertStatuslineSnapshot ?? defaultInsertStatuslineSnapshot,
    listLatestSnapshotPerSession:
      deps.listLatestSnapshotPerSession ?? defaultListLatestSnapshotPerSession,
    getLatestSnapshotForProject:
      deps.getLatestSnapshotForProject ?? defaultGetLatestSnapshotForProject,
  };
  const latestStatuslineByProject = new Map<string, StatuslineSnapshot>();

  /** Section 31.7 -- statusline-command bridge. CC's `statusLine.command` hook
   *  POSTs here on every status-line refresh with the extracted snapshot. */
  app.post('/api/internal/statusline-data', async (c) => {
    let body: Partial<StatuslineSnapshot & { projectId: string }>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid json' }, 400);
    }
    if (!body.projectId || !body.pcSessionId) {
      return c.json({ ok: false, error: 'projectId + pcSessionId required' }, 400);
    }
    const snapshot: StatuslineSnapshot = {
      pcSessionId: body.pcSessionId,
      ccSessionId: body.ccSessionId ?? '',
      receivedAt: services.now(),
      model: body.model ?? null,
      rateLimits: body.rateLimits ?? { fiveHour: null, sevenDay: null },
      cost: body.cost ?? null,
      contextWindow: body.contextWindow ?? null,
    };
    latestStatuslineByProject.set(body.projectId, snapshot);
    try {
      services.insertStatuslineSnapshot({
        id: services.newId(),
        projectId: body.projectId as ULID,
        pcSessionId: snapshot.pcSessionId,
        ccSessionId: snapshot.ccSessionId || null,
        receivedAt: snapshot.receivedAt,
        modelId: snapshot.model?.id ?? null,
        modelDisplayName: snapshot.model?.displayName ?? null,
        fiveHourPct: snapshot.rateLimits.fiveHour?.usedPercentage ?? null,
        fiveHourResetsAt: snapshot.rateLimits.fiveHour?.resetsAt ?? null,
        sevenDayPct: snapshot.rateLimits.sevenDay?.usedPercentage ?? null,
        sevenDayResetsAt: snapshot.rateLimits.sevenDay?.resetsAt ?? null,
        totalCostUsd: snapshot.cost?.totalCostUsd ?? null,
        totalDurationMs: snapshot.cost?.totalDurationMs ?? null,
        totalApiDurationMs: snapshot.cost?.totalApiDurationMs ?? null,
        contextCurrentUsage: snapshot.contextWindow?.currentUsage ?? null,
        contextWindowSize: snapshot.contextWindow?.contextWindowSize ?? null,
        contextUsedPercentage: snapshot.contextWindow?.usedPercentage ?? null,
        totalInputTokens: snapshot.contextWindow?.totalInputTokens ?? null,
        totalOutputTokens: snapshot.contextWindow?.totalOutputTokens ?? null,
      });
    } catch (err) {
      console.warn('[31.11] statusline persist skipped:', (err as Error).message);
    }
    deps.broadcastTo(body.projectId as ULID, { type: 'statusline-snapshot', snapshot });
    return c.json({ ok: true });
  });

  /** Section 31.11 -- usage aggregation. Buckets latest-cost-per-session by
   *  day, week, or month over a caller-supplied window. */
  app.get('/api/usage/aggregate', (c) => {
    const bucket = (c.req.query('bucket') ?? 'day').toLowerCase();
    if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
      return c.json({ ok: false, error: "bucket must be day|week|month" }, 400);
    }
    const windowDays = Math.min(365, Math.max(1, Number(c.req.query('windowDays') ?? 30)));
    const sinceMs = services.now() - windowDays * 24 * 60 * 60 * 1000;
    const rows = services.listLatestSnapshotPerSession(sinceMs);
    const buckets = new Map<
      string,
      { costUsd: number; sessions: number; inputTokens: number; outputTokens: number }
    >();
    for (const r of rows) {
      const key = formatBucket(new Date(r.receivedAt), bucket);
      const entry =
        buckets.get(key) ?? { costUsd: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
      entry.costUsd += r.totalCostUsd ?? 0;
      entry.inputTokens += r.totalInputTokens ?? 0;
      entry.outputTokens += r.totalOutputTokens ?? 0;
      entry.sessions += 1;
      buckets.set(key, entry);
    }
    const result = Array.from(buckets.entries())
      .map(([b, v]) => ({
        bucket: b,
        costUsd: v.costUsd,
        sessions: v.sessions,
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
      }))
      .sort((a, b) => (a.bucket < b.bucket ? 1 : a.bucket > b.bucket ? -1 : 0));
    return c.json({ ok: true, bucket, windowDays, rows: result });
  });

  /** Latest snapshot for a project; null if none received yet. */
  app.get('/api/projects/:projectId/statusline', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const memSnapshot = latestStatuslineByProject.get(projectId);
    if (memSnapshot) return c.json({ ok: true, snapshot: memSnapshot });
    const row = services.getLatestSnapshotForProject(projectId);
    if (!row) return c.json({ ok: true, snapshot: null });
    return c.json({ ok: true, snapshot: snapshotFromRow(row) });
  });
}

export function formatBucket(d: Date, kind: UsageBucket): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (kind === 'month') return `${y}-${m}`;
  if (kind === 'day') {
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function snapshotFromRow(row: StatuslineSnapshotRow): StatuslineSnapshot {
  return {
    pcSessionId: row.pcSessionId,
    ccSessionId: row.ccSessionId ?? '',
    receivedAt: row.receivedAt,
    model: row.modelId
      ? { id: row.modelId, displayName: row.modelDisplayName ?? row.modelId }
      : null,
    rateLimits: {
      fiveHour:
        row.fiveHourPct != null && row.fiveHourResetsAt
          ? { usedPercentage: row.fiveHourPct, resetsAt: row.fiveHourResetsAt }
          : null,
      sevenDay:
        row.sevenDayPct != null && row.sevenDayResetsAt
          ? { usedPercentage: row.sevenDayPct, resetsAt: row.sevenDayResetsAt }
          : null,
    },
    cost:
      row.totalCostUsd != null
        ? {
            totalCostUsd: row.totalCostUsd,
            totalDurationMs: row.totalDurationMs ?? 0,
            totalApiDurationMs: row.totalApiDurationMs ?? 0,
          }
        : null,
    contextWindow:
      row.contextCurrentUsage != null && row.contextWindowSize != null
        ? {
            currentUsage: row.contextCurrentUsage,
            contextWindowSize: row.contextWindowSize,
            usedPercentage: row.contextUsedPercentage ?? 0,
            totalInputTokens: row.totalInputTokens ?? 0,
            totalOutputTokens: row.totalOutputTokens ?? 0,
          }
        : null,
  };
}
