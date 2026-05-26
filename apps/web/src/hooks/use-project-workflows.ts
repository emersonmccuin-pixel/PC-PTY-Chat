// Section 19.18 — Project workflows hook (mirrors `use-project-pods.ts`).
//
// Reads the DB-backed `/api/workflows?projectId=…` surface (globals ∪
// project-scope rows for the active project) and applies `workflow-changed`
// envelopes as deltas.
//
// Envelope shapes (server emits both forms — see workflow-routes.ts:238-255):
//   { type: 'workflow-changed', change: 'created' | 'updated', workflow: WorkflowRow }
//   { type: 'workflow-changed', change: 'deleted', workflowId, slug, scope, projectId }
//
// Visibility filter: globals are visible to every project; project-scope rows
// are only kept when projectId matches. Cross-project envelopes from
// `broadcastAll` (used for global mutations) still need the projectId check.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Project, ULID, WorkflowRow } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

interface WorkflowChangedEnvelope extends WsEnvelope {
  type: 'workflow-changed';
  change: 'created' | 'updated' | 'deleted';
  workflow?: WorkflowRow;
  workflowId?: ULID;
  slug?: string;
  scope?: 'global' | 'project';
  // `projectId` on the envelope is the broadcast tag (the WS connection's
  // project); the workflow row's own scope/projectId carries visibility.
}

export function useProjectWorkflows(
  project: Project | null,
  events: WsEnvelope[],
): { workflows: WorkflowRow[]; refetch: () => void } {
  const [map, setMap] = useState<Map<ULID, WorkflowRow>>(() => new Map());
  const lastProcessedIdx = useRef(0);

  useEffect(() => {
    if (!project) {
      setMap(new Map());
      lastProcessedIdx.current = 0;
      return;
    }
    let cancelled = false;
    void api.listWorkflowRows(project.id).then((list) => {
      if (cancelled) return;
      setMap(new Map(list.map((w) => [w.id, w])));
    });
    lastProcessedIdx.current = events.length;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    if (!project || events.length === 0) {
      lastProcessedIdx.current = events.length;
      return;
    }
    if (events.length < lastProcessedIdx.current) lastProcessedIdx.current = 0;
    const start = lastProcessedIdx.current;
    if (start >= events.length) return;

    const upserts: WorkflowRow[] = [];
    const deletes: ULID[] = [];

    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (!env || env.type !== 'workflow-changed') continue;
      const e = env as WorkflowChangedEnvelope;
      if (e.change === 'deleted') {
        if (e.workflowId) deletes.push(e.workflowId);
        continue;
      }
      if (!e.workflow) continue;
      // Filter to rows visible to this project: globals + this project's
      // project-scope rows. The server uses broadcastAll for global mutations,
      // so other projects' rows would otherwise leak in.
      if (e.workflow.scope === 'global' || e.workflow.projectId === project.id) {
        upserts.push(e.workflow);
      } else if (e.workflow.scope === 'project' && e.workflow.projectId !== project.id) {
        // Cross-project row — ignore. Defensive (broadcastTo should keep them
        // scoped, but a malformed envelope shouldn't pollute our map).
      }
    }
    lastProcessedIdx.current = events.length;

    if (upserts.length > 0 || deletes.length > 0) {
      setMap((prev) => {
        const next = new Map(prev);
        for (const w of upserts) next.set(w.id, w);
        for (const id of deletes) next.delete(id);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, project?.id]);

  const workflows = useMemo(
    () =>
      Array.from(map.values()).sort((a, b) => {
        // This project first, then global; alpha within.
        if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [map],
  );

  return {
    workflows,
    refetch: () => {
      if (!project) return;
      void api.listWorkflowRows(project.id).then((list) => {
        setMap(new Map(list.map((w) => [w.id, w])));
      });
    },
  };
}
