// Q12 multi-project WS subscription.
//
// Opens one WebSocket per project in `projects` when `enabled` is true,
// excluding `excludeProjectId` (the active project — `useProjectWs` already
// owns that socket). The server's per-project subscriber map supersedes
// prior connections (`apps/server/src/index.ts:780`), so we must NOT open a
// second socket for the active project; doing so would close the one that
// drives Orchestrator/Kanban.
//
// Returns a single merged event list (newest at end, matching useProjectWs)
// plus an aggregate status: 'open' if every socket is open, 'connecting' if
// any are still handshaking with none closed, 'closed' if any are closed,
// 'idle' if disabled or no eligible projects.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '@/api/client';
import type { WsEnvelope, WsStatus } from './use-project-ws';

const MAX_BUFFERED = 500;

interface UseAllProjectsWsResult {
  events: WsEnvelope[];
  status: WsStatus;
}

export function useAllProjectsWs(
  projects: Project[],
  excludeProjectId: string | null,
  enabled: boolean,
): UseAllProjectsWsResult {
  const [events, setEvents] = useState<WsEnvelope[]>([]);
  const [statuses, setStatuses] = useState<Record<string, WsStatus>>({});
  const socketsRef = useRef<Map<string, WebSocket>>(new Map());

  // Stable key — re-open sockets only when the eligible project ID set
  // changes, not on every Project[] identity flip.
  const targetIds = useMemo(() => {
    if (!enabled) return [];
    return projects
      .map((p) => p.id)
      .filter((id) => id !== excludeProjectId)
      .sort();
  }, [projects, excludeProjectId, enabled]);
  const targetKey = targetIds.join(',');

  useEffect(() => {
    setEvents([]);
    setStatuses({});

    if (targetIds.length === 0) {
      // Close any lingering sockets if we toggled off.
      for (const ws of socketsRef.current.values()) {
        try { ws.close(); } catch { /* best-effort */ }
      }
      socketsRef.current.clear();
      return;
    }

    const sockets = new Map<string, WebSocket>();
    socketsRef.current = sockets;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';

    for (const projectId of targetIds) {
      const url = `${proto}://${window.location.host}/ws?projectId=${encodeURIComponent(projectId)}`;
      const ws = new WebSocket(url);
      sockets.set(projectId, ws);
      setStatuses((prev) => ({ ...prev, [projectId]: 'connecting' }));

      ws.addEventListener('open', () =>
        setStatuses((prev) => ({ ...prev, [projectId]: 'open' })),
      );
      ws.addEventListener('close', () =>
        setStatuses((prev) => ({ ...prev, [projectId]: 'closed' })),
      );
      ws.addEventListener('error', () =>
        setStatuses((prev) => ({ ...prev, [projectId]: 'closed' })),
      );
      ws.addEventListener('message', (e) => {
        let env: WsEnvelope | null = null;
        try {
          env = JSON.parse(typeof e.data === 'string' ? e.data : '') as WsEnvelope;
        } catch {
          return;
        }
        if (!env || env.projectId !== projectId) return;
        setEvents((prev) => {
          const next = [...prev, env!];
          return next.length > MAX_BUFFERED ? next.slice(next.length - MAX_BUFFERED) : next;
        });
      });
    }

    return () => {
      for (const ws of sockets.values()) {
        try { ws.close(); } catch { /* best-effort */ }
      }
      sockets.clear();
    };
  }, [targetKey, targetIds]);

  const status = aggregateStatus(targetIds, statuses, enabled);

  return { events, status };
}

function aggregateStatus(
  targetIds: string[],
  statuses: Record<string, WsStatus>,
  enabled: boolean,
): WsStatus {
  if (!enabled || targetIds.length === 0) return 'idle';
  let anyConnecting = false;
  let anyClosed = false;
  let openCount = 0;
  for (const id of targetIds) {
    const s = statuses[id];
    if (s === 'open') openCount += 1;
    else if (s === 'closed') anyClosed = true;
    else anyConnecting = true;
  }
  if (anyClosed) return 'closed';
  if (anyConnecting) return 'connecting';
  return openCount === targetIds.length ? 'open' : 'connecting';
}
