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

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Project } from '@/api/client';

export interface WsEnvelope {
  projectId: string;
  type: string;
  [k: string]: unknown;
}

// ── Chat-event shapes ─────────────────────────────────────────────────────
// Server emits hook-driven events as `{type:'event', event:{kind,...}}`. The
// kinds + fields below mirror packages/runtime/src/hook-scripts/event-capture.cjs
// (plus the workflow-runtime's `approval-required`). Keep in sync if those
// hook payloads grow.

export interface ChatEventBase {
  ts?: string;
  kind: string;
}

export interface UserEvent extends ChatEventBase {
  kind: 'user';
  text: string;
}

export interface AssistantEvent extends ChatEventBase {
  kind: 'assistant';
  text: string;
  transcriptPath?: string | null;
}

export interface ToolStartEvent extends ChatEventBase {
  kind: 'tool-start';
  tool: string;
  input?: unknown;
}

export interface ToolEndEvent extends ChatEventBase {
  kind: 'tool-end';
  tool: string;
  result?: unknown;
}

export interface TodoItem {
  content?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed';
}

export interface TodosEvent extends ChatEventBase {
  kind: 'todos';
  todos: TodoItem[];
}

export interface TaskStartEvent extends ChatEventBase {
  kind: 'task-start';
  subagent: string;
  description?: string;
  prompt?: string;
}

export interface TaskEndEvent extends ChatEventBase {
  kind: 'task-end';
  subagent: string;
  result?: string;
}

export interface ApprovalRequiredEvent extends ChatEventBase {
  kind: 'approval-required';
  workflowRunId: string;
  nodeId: string;
  message?: string;
  on_reject_prompt?: string;
}

export type ChatEvent =
  | UserEvent
  | AssistantEvent
  | ToolStartEvent
  | ToolEndEvent
  | TodosEvent
  | TaskStartEvent
  | TaskEndEvent
  | ApprovalRequiredEvent
  | (ChatEventBase & Record<string, unknown>);

// ── Outbound WS messages (Q8 chat send + interrupt + ask-reply) ───────────

export type WsOutbound =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ask-reply'; toolUseId: string; answer: string };

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface UseProjectWsResult {
  events: WsEnvelope[];
  status: WsStatus;
  clear: () => void;
  send: (msg: WsOutbound) => boolean;
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

  const send = useCallback((msg: WsOutbound): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  return {
    events,
    status,
    clear: () => setEvents([]),
    send,
  };
}
