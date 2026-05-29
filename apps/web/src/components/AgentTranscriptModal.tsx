// Section 16b.8.3 — Activity Panel live-transcript modal for a running agent.
//
// Opens when the user clicks a Running agents card. Renders a slide-in panel
// (same pattern as WorkflowDrawer) with:
//   - Header: agent name + sessionId + worktreeDir + status pill
//   - Body: live transcript of JSONL events forwarded by the server as
//     `{ type: 'agent-jsonl-event', runId, event }` envelopes
//
// On open, the modal backfills prior events through
// `GET /api/projects/:projectId/agent-runs/:runId/events`, then appends live
// `agent-jsonl-event` envelopes from the project's WS stream.
//
// Modal dismiss contract: explicit Close button only — no Escape, no backdrop
// click. Per `feedback_modals_explicit_close_only`.

import { useEffect, useMemo, useRef, useState } from 'react';

import { agentRunsApi, type AgentRunRecord } from '@/features/agent-runs/client';
import {
  agentTranscriptEmptyMessage,
  mergeAgentTranscriptEvents,
  type AgentTranscriptLoadStatus,
} from '@/features/agent-runs/transcript';
import type { AgentRunTranscriptStatus } from '@/features/agent-runs/types';
import type { JsonlEvent, WsEnvelope } from '@/features/runtime/ws-types';

interface AgentTranscriptModalProps {
  run: AgentRunRecord;
  events: WsEnvelope[];
  onClose: () => void;
}

export function AgentTranscriptModal({ run, events, onClose }: AgentTranscriptModalProps) {
  const [backfill, setBackfill] = useState<{
    status: AgentTranscriptLoadStatus;
    transcriptStatus: AgentRunTranscriptStatus | null;
    events: JsonlEvent[];
    jsonlPath: string | null;
    error: string | null;
  }>({
    status: 'loading',
    transcriptStatus: null,
    events: [],
    jsonlPath: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setBackfill({
      status: 'loading',
      transcriptStatus: null,
      events: [],
      jsonlPath: null,
      error: null,
    });
    agentRunsApi
      .getAgentRunEvents(run.projectId, run.runId)
      .then((response) => {
        if (cancelled) return;
        setBackfill({
          status: 'ready',
          transcriptStatus: response.transcriptStatus,
          events: response.events as JsonlEvent[],
          jsonlPath: response.jsonlPath,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setBackfill({
          status: 'error',
          transcriptStatus: null,
          events: [],
          jsonlPath: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [run.projectId, run.runId]);

  const transcriptItems = useMemo(
    () =>
      mergeAgentTranscriptEvents({
        runId: run.runId,
        backfillEvents: backfill.events,
        events,
      }),
    [backfill.events, events, run.runId],
  );

  // Auto-scroll body to bottom when new events arrive.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcriptItems.length]);

  const statusPillClasses =
    run.status === 'paused'
      ? 'bg-warning/25 text-warning'
      : run.status === 'spawning'
        ? 'bg-muted text-muted-foreground'
        : 'bg-primary/20 text-primary';

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal
      aria-label="Agent transcript"
    >
      <div className="flex-1 bg-black/40" aria-hidden="true" />
      <aside className="flex h-full w-full max-w-6xl flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Agent
            </div>
            <div className="flex items-baseline gap-2">
              <div className="truncate text-sm font-semibold text-foreground">
                {run.agentName}
              </div>
              <span
                className={`shrink-0 px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${statusPillClasses}`}
              >
                {run.status}
              </span>
            </div>
            <div
              className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
              title={run.sessionId}
            >
              session: {run.sessionId}
            </div>
            <div
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={run.worktreeDir}
            >
              cwd: {run.worktreeDir}
            </div>
            {backfill.jsonlPath && (
              <div
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={backfill.jsonlPath}
              >
                jsonl: {backfill.jsonlPath}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            className="shrink-0 border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            ✕ Close
          </button>
        </header>

        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        >
          {transcriptItems.length === 0 ? (
            <div className="text-xs italic text-muted-foreground">
              {agentTranscriptEmptyMessage({
                loadStatus: backfill.status,
                transcriptStatus: backfill.transcriptStatus,
              })}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {transcriptItems.map((item) => (
                <TranscriptRow key={item.key} event={item.event} />
              ))}
            </ul>
          )}
          {backfill.status === 'error' && (
            <div className="mt-3 text-xs text-destructive">
              Backfill unavailable: {backfill.error}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function TranscriptRow({ event }: { event: JsonlEvent }) {
  switch (event.kind) {
    case 'jsonl-user':
      return (
        <Row label="user" tone="user">
          <div className="whitespace-pre-wrap text-foreground">{event.text}</div>
        </Row>
      );
    case 'jsonl-turn-end':
      return (
        <Row label="assistant" tone="assistant">
          <div className="whitespace-pre-wrap text-foreground">{event.text}</div>
          {event.stopReason && event.stopReason !== 'end_turn' && (
            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
              stop: {event.stopReason}
            </div>
          )}
        </Row>
      );
    case 'jsonl-tool-call':
      return (
        <Row label={`tool: ${event.name}`} tone="tool">
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {truncate(safeJson(event.input), 800)}
          </pre>
        </Row>
      );
    case 'jsonl-tool-result':
      return (
        <Row label={event.isError ? 'tool result · error' : 'tool result'} tone={event.isError ? 'error' : 'tool'}>
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {truncate(safeJson(event.result), 800)}
          </pre>
        </Row>
      );
    case 'jsonl-system':
      return (
        <Row label={`system · ${event.subtype}`} tone={event.level === 'error' ? 'error' : 'system'}>
          <div className="whitespace-pre-wrap text-foreground">{event.message}</div>
        </Row>
      );
    case 'jsonl-usage':
      return (
        <Row label="usage" tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">
            in {event.inputTokens} · out {event.outputTokens} · cache-r {event.cacheReadTokens} · cache-w {event.cacheCreationTokens}
            {event.model ? ` · ${event.model}` : ''}
          </div>
        </Row>
      );
    case 'jsonl-queue-enqueue':
    case 'jsonl-queue-dequeue':
    case 'jsonl-sidechain':
      return (
        <Row label={event.kind.replace(/^jsonl-/, '')} tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">—</div>
        </Row>
      );
    default:
      return (
        <Row label="event" tone="muted">
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
            {truncate(safeJson(event), 400)}
          </pre>
        </Row>
      );
  }
}

type RowTone = 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'muted';

function Row({
  label,
  tone,
  children,
}: {
  label: string;
  tone: RowTone;
  children: React.ReactNode;
}) {
  const toneClasses: Record<RowTone, string> = {
    user: 'border-l-primary/60',
    assistant: 'border-l-foreground/30',
    tool: 'border-l-muted-foreground/40',
    system: 'border-l-warning/60',
    error: 'border-l-destructive/70',
    muted: 'border-l-border',
  };
  return (
    <li className={`border-l-2 ${toneClasses[tone]} pl-2`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-xs">{children}</div>
    </li>
  );
}

function safeJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}
