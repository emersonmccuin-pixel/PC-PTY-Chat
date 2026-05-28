import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hono } from 'hono';
import type { StatuslineSnapshot, ULID } from '@pc/domain';
import type { InsertStatuslineSnapshotInput, StatuslineSnapshotRow } from '@pc/db';

import {
  formatBucket,
  registerStatuslineRoutes,
} from '../src/features/statusline/routes.ts';

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

function makeRow(patch: Partial<StatuslineSnapshotRow> = {}): StatuslineSnapshotRow {
  return {
    id: 'row-1' as ULID,
    projectId: 'project-1' as ULID,
    pcSessionId: 'pc-session-1',
    ccSessionId: 'cc-session-1',
    receivedAt: Date.UTC(2026, 4, 27, 12),
    modelId: 'claude-opus-4',
    modelDisplayName: 'Claude Opus 4',
    fiveHourPct: 42,
    fiveHourResetsAt: '2026-05-27T17:00:00.000Z',
    sevenDayPct: 20,
    sevenDayResetsAt: '2026-06-01T00:00:00.000Z',
    totalCostUsd: 1.23,
    totalDurationMs: 4000,
    totalApiDurationMs: 3000,
    contextCurrentUsage: 12000,
    contextWindowSize: 200000,
    contextUsedPercentage: 6,
    totalInputTokens: 1000,
    totalOutputTokens: 250,
    ...patch,
  };
}

function makeHarness(opts: {
  now?: number;
  latestRow?: StatuslineSnapshotRow | null;
  aggregateRows?: Array<{
    pcSessionId: string;
    projectId: ULID;
    receivedAt: number;
    totalCostUsd: number | null;
    modelId: string | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
  }>;
} = {}) {
  const inserted: InsertStatuslineSnapshotInput[] = [];
  const broadcasts: Array<{ projectId: ULID; msg: unknown }> = [];
  const aggregateSince: number[] = [];
  const latestProjectIds: ULID[] = [];
  const app = new Hono();
  registerStatuslineRoutes(app, {
    now: () => opts.now ?? Date.UTC(2026, 4, 27, 12),
    newId: () => 'snapshot-id' as ULID,
    insertStatuslineSnapshot: (input) => inserted.push(input),
    listLatestSnapshotPerSession: (sinceMs) => {
      aggregateSince.push(sinceMs);
      return opts.aggregateRows ?? [];
    },
    getLatestSnapshotForProject: (projectId) => {
      latestProjectIds.push(projectId);
      return opts.latestRow ?? null;
    },
    broadcastTo: (projectId, msg) => broadcasts.push({ projectId, msg }),
  });
  return { app, inserted, broadcasts, aggregateSince, latestProjectIds };
}

test('statusline POST validates JSON and required fields', async () => {
  const { app } = makeHarness();

  let res = await app.request('/api/internal/statusline-data', {
    method: 'POST',
    body: '{',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'invalid json' });

  res = await app.request('/api/internal/statusline-data', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-1' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'projectId + pcSessionId required',
  });
});

test('statusline POST persists, broadcasts, and serves the in-memory latest snapshot', async () => {
  const now = Date.UTC(2026, 4, 27, 15, 30);
  const { app, inserted, broadcasts, latestProjectIds } = makeHarness({ now });
  const payload = {
    projectId: 'project-1',
    pcSessionId: 'pc-session-1',
    ccSessionId: 'cc-session-1',
    model: { id: 'claude-opus-4', displayName: 'Claude Opus 4' },
    rateLimits: {
      fiveHour: { usedPercentage: 70, resetsAt: '2026-05-27T20:00:00.000Z' },
      sevenDay: null,
    },
    cost: { totalCostUsd: 2.5, totalDurationMs: 1000, totalApiDurationMs: 800 },
    contextWindow: {
      currentUsage: 100,
      contextWindowSize: 200,
      usedPercentage: 50,
      totalInputTokens: 75,
      totalOutputTokens: 25,
    },
  };

  const res = await app.request('/api/internal/statusline-data', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.deepEqual(inserted, [
    {
      id: 'snapshot-id',
      projectId: 'project-1',
      pcSessionId: 'pc-session-1',
      ccSessionId: 'cc-session-1',
      receivedAt: now,
      modelId: 'claude-opus-4',
      modelDisplayName: 'Claude Opus 4',
      fiveHourPct: 70,
      fiveHourResetsAt: '2026-05-27T20:00:00.000Z',
      sevenDayPct: null,
      sevenDayResetsAt: null,
      totalCostUsd: 2.5,
      totalDurationMs: 1000,
      totalApiDurationMs: 800,
      contextCurrentUsage: 100,
      contextWindowSize: 200,
      contextUsedPercentage: 50,
      totalInputTokens: 75,
      totalOutputTokens: 25,
    },
  ]);

  const snapshot: StatuslineSnapshot = {
    pcSessionId: 'pc-session-1',
    ccSessionId: 'cc-session-1',
    receivedAt: now,
    model: { id: 'claude-opus-4', displayName: 'Claude Opus 4' },
    rateLimits: {
      fiveHour: { usedPercentage: 70, resetsAt: '2026-05-27T20:00:00.000Z' },
      sevenDay: null,
    },
    cost: { totalCostUsd: 2.5, totalDurationMs: 1000, totalApiDurationMs: 800 },
    contextWindow: {
      currentUsage: 100,
      contextWindowSize: 200,
      usedPercentage: 50,
      totalInputTokens: 75,
      totalOutputTokens: 25,
    },
  };
  assert.deepEqual(broadcasts, [
    { projectId: 'project-1' as ULID, msg: { type: 'statusline-snapshot', snapshot } },
  ]);

  const latest = await app.request('/api/projects/project-1/statusline');
  assert.equal(latest.status, 200);
  assert.deepEqual(await json(latest), { ok: true, snapshot });
  assert.deepEqual(latestProjectIds, []);
});

test('statusline GET reconstructs fallback rows and null snapshot envelopes', async () => {
  let harness = makeHarness({
    latestRow: makeRow({
      ccSessionId: null,
      modelDisplayName: null,
      sevenDayPct: null,
      sevenDayResetsAt: null,
      totalDurationMs: null,
      totalApiDurationMs: null,
      contextUsedPercentage: null,
      totalInputTokens: null,
      totalOutputTokens: null,
    }),
  });

  let res = await harness.app.request('/api/projects/project-1/statusline');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    snapshot: {
      pcSessionId: 'pc-session-1',
      ccSessionId: '',
      receivedAt: Date.UTC(2026, 4, 27, 12),
      model: { id: 'claude-opus-4', displayName: 'claude-opus-4' },
      rateLimits: {
        fiveHour: { usedPercentage: 42, resetsAt: '2026-05-27T17:00:00.000Z' },
        sevenDay: null,
      },
      cost: { totalCostUsd: 1.23, totalDurationMs: 0, totalApiDurationMs: 0 },
      contextWindow: {
        currentUsage: 12000,
        contextWindowSize: 200000,
        usedPercentage: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    },
  });
  assert.deepEqual(harness.latestProjectIds, ['project-1']);

  harness = makeHarness({ latestRow: null });
  res = await harness.app.request('/api/projects/project-2/statusline');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, snapshot: null });
});

test('usage aggregation preserves bucket validation, clamping, sums, and sort order', async () => {
  const now = Date.UTC(2026, 4, 27, 12);
  const harness = makeHarness({
    now,
    aggregateRows: [
      {
        pcSessionId: 'pc-1',
        projectId: 'project-1' as ULID,
        receivedAt: Date.UTC(2026, 4, 27, 10),
        totalCostUsd: 1.5,
        modelId: 'opus',
        totalInputTokens: 100,
        totalOutputTokens: 50,
      },
      {
        pcSessionId: 'pc-2',
        projectId: 'project-1' as ULID,
        receivedAt: Date.UTC(2026, 4, 26, 10),
        totalCostUsd: null,
        modelId: null,
        totalInputTokens: null,
        totalOutputTokens: 25,
      },
      {
        pcSessionId: 'pc-3',
        projectId: 'project-2' as ULID,
        receivedAt: Date.UTC(2026, 4, 27, 11),
        totalCostUsd: 2,
        modelId: 'sonnet',
        totalInputTokens: 10,
        totalOutputTokens: null,
      },
    ],
  });

  let res = await harness.app.request('/api/usage/aggregate?bucket=year');
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'bucket must be day|week|month' });

  res = await harness.app.request('/api/usage/aggregate?bucket=day&windowDays=999');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    bucket: 'day',
    windowDays: 365,
    rows: [
      {
        bucket: '2026-05-27',
        costUsd: 3.5,
        sessions: 2,
        inputTokens: 110,
        outputTokens: 50,
      },
      {
        bucket: '2026-05-26',
        costUsd: 0,
        sessions: 1,
        inputTokens: 0,
        outputTokens: 25,
      },
    ],
  });
  assert.deepEqual(harness.aggregateSince, [now - 365 * 24 * 60 * 60 * 1000]);
});

test('formatBucket preserves UTC day, month, and ISO-week buckets', () => {
  assert.equal(formatBucket(new Date(Date.UTC(2026, 4, 27, 23)), 'day'), '2026-05-27');
  assert.equal(formatBucket(new Date(Date.UTC(2026, 4, 27, 23)), 'month'), '2026-05');
  assert.equal(formatBucket(new Date(Date.UTC(2026, 0, 1, 12)), 'week'), '2026-W01');
});
