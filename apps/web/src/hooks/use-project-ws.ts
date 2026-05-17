// Per-project WebSocket subscription.
//
// Server contract: `/ws?projectId=<ULID>`. Opening with a projectId supersedes
// any prior connection for that project (server-side `subscribers.set`), so we
// can switch projects cleanly by simply opening a new WS — no manual unsub
// needed. The per-project scope means events are pre-filtered: if you only
// want one project's events, you only get that project's events.
//
// "All projects" mode (ActivityPanel toggle, Q12) is handled by a sibling
// hook (useAllProjectsWs) that opens one socket per non-active project.
//
// Q13 hardening: exponential backoff on reconnect (2 → 5 → 15 → 30s cap), a
// single status-update per disconnect (the WsStatus state only flips once
// per close), and seenTs dedup so the server's events.jsonl replay (which
// fires on every connect — `apps/server/src/index.ts:818`) doesn't
// double-render history after a retry.

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
  toolUseId?: string | null;
  input?: unknown;
}

export interface ToolEndEvent extends ChatEventBase {
  kind: 'tool-end';
  tool: string;
  toolUseId?: string | null;
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
/** Backoff schedule from legacy `apps/web/legacy/app.js:545` (Session F #4). */
export const RECONNECT_SCHEDULE_MS = [2_000, 5_000, 15_000, 30_000] as const;

export function nextBackoffMs(prevDelay: number): number {
  const idx = RECONNECT_SCHEDULE_MS.indexOf(prevDelay as (typeof RECONNECT_SCHEDULE_MS)[number]);
  if (idx === -1 || idx === RECONNECT_SCHEDULE_MS.length - 1) return RECONNECT_SCHEDULE_MS[RECONNECT_SCHEDULE_MS.length - 1]!;
  return RECONNECT_SCHEDULE_MS[idx + 1]!;
}

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

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let delay: number = RECONNECT_SCHEDULE_MS[0];
    const seenTs = new Set<string>();

    function connect(): void {
      if (cancelled) return;
      setStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${window.location.host}/ws?projectId=${encodeURIComponent(project!.id)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (cancelled) return;
        setStatus('open');
        delay = RECONNECT_SCHEDULE_MS[0];
      });

      ws.addEventListener('close', () => {
        if (cancelled) return;
        wsRef.current = null;
        setStatus('closed');
        const wait = delay;
        delay = nextBackoffMs(delay);
        retryTimer = setTimeout(connect, wait);
      });

      ws.addEventListener('error', () => {
        // `close` fires too — handle the retry there.
      });

      ws.addEventListener('message', (e) => {
        if (cancelled) return;
        let env: WsEnvelope | null = null;
        try {
          env = JSON.parse(typeof e.data === 'string' ? e.data : '') as WsEnvelope;
        } catch {
          return;
        }
        if (!env || env.projectId !== project!.id) return;
        if (env.type === 'event') {
          const inner = (env.event as { ts?: unknown } | undefined) ?? {};
          if (typeof inner.ts === 'string') {
            if (seenTs.has(inner.ts)) return;
            seenTs.add(inner.ts);
          }
        }
        const final = env;
        // session-changed marks a hard checkpoint: the server wiped events.jsonl
        // and minted a fresh Claude session. Drop everything prior so the chat
        // panel matches what Claude actually has in context.
        if (final.type === 'session-changed') {
          seenTs.clear();
          setEvents([final]);
          return;
        }
        setEvents((prev) => {
          const next = [...prev, final];
          return next.length > MAX_BUFFERED ? next.slice(next.length - MAX_BUFFERED) : next;
        });
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try { ws.close(); } catch { /* best-effort */ }
      }
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
