// Per-project WebSocket subscription.
//
// Server contract: `/ws?projectId=<ULID>`. Opening with a projectId supersedes
// any prior connection for that project (server-side `subscribers.set`), so we
// can switch projects cleanly by simply opening a new WS — no manual unsub
// needed. The per-project scope means events are pre-filtered: if you only
// want one project's events, you only get that project's events.
//
// "All projects" mode (ActivityPanel toggle, Q12) will need a separate hook
// that opens N parallel connections — out of scope here.

import { useEffect, useRef, useState } from 'react';

import type { Project } from '@/api/client';

export interface WsEnvelope {
  projectId: string;
  type: string;
  [k: string]: unknown;
}

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface UseProjectWsResult {
  events: WsEnvelope[];
  status: WsStatus;
  clear: () => void;
}

const MAX_BUFFERED = 500;

export function useProjectWs(project: Project | null): UseProjectWsResult {
  const [events, setEvents] = useState<WsEnvelope[]>([]);
  const [status, setStatus] = useState<WsStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setEvents([]);
    if (!project) {
      setStatus('idle');
      return;
    }
    setStatus('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws?projectId=${encodeURIComponent(project.id)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener('open', () => setStatus('open'));
    ws.addEventListener('close', () => {
      // Q13 hardens this with exponential backoff. For Q6 we just mark closed.
      setStatus('closed');
    });
    ws.addEventListener('error', () => setStatus('closed'));
    ws.addEventListener('message', (e) => {
      let env: WsEnvelope | null = null;
      try {
        env = JSON.parse(typeof e.data === 'string' ? e.data : '') as WsEnvelope;
      } catch {
        return;
      }
      if (!env || env.projectId !== project.id) return;
      setEvents((prev) => {
        const next = [...prev, env!];
        return next.length > MAX_BUFFERED ? next.slice(next.length - MAX_BUFFERED) : next;
      });
    });

    return () => {
      try {
        ws.close();
      } catch {
        // best-effort
      }
      wsRef.current = null;
    };
  }, [project]);

  return {
    events,
    status,
    clear: () => setEvents([]),
  };
}
