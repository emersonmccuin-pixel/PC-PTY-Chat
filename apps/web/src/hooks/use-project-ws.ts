// Per-project WebSocket subscription.
//
// Server contract: `/ws?projectId=<ULID>`. Each tab/view subscribes to the
// project's broadcast stream independently; the server no longer supersedes
// same-project sockets. The per-project scope means events are pre-filtered:
// if you only want one project's events, you only get that project's events.
//
// "All projects" mode (ActivityPanel toggle, Q12) is handled by a sibling
// hook (useAllProjectsWs) that opens one socket per non-active project.
//
// Q13 hardening: exponential backoff on reconnect (2 → 5 → 15 → 30s cap), a
// single status-update per disconnect (the WsStatus state only flips once
// per close), and seenTs dedup so legacy hook events don't double-render
// around reconnects. Active-session history now arrives as one
// `session-replay` checkpoint instead of a burst of individual WS messages.

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  OrchestratorRuntimeSnapshot,
  Project,
  SessionReplayItem,
  SessionTransitionKind,
  SessionTransitionResponse,
} from '@/api/client';

export interface WsEnvelope {
  projectId: string;
  type: string;
  [k: string]: unknown;
}

export interface SendAckEnvelope extends WsEnvelope {
  type: 'send-ack';
  clientMessageId: string;
  ok: boolean;
  status: 'received' | 'queued' | 'invalid-message' | 'no-session' | 'error';
  error?: string;
  queueItem?: SendQueueItem;
}

export interface SendQueueItem {
  id: string;
  clientMessageId: string;
  text: string;
  status:
    | 'queued_busy'
    | 'queued_spawning'
    | 'queued_backlog'
    | 'delivering'
    | 'delivered_to_pty'
    | 'observed_in_jsonl'
    | 'failed'
    | 'cancelled';
  createdAt: number;
  updatedAt: number;
  deliveryAttempts: number;
  failureReason: string | null;
}

export interface SendQueueSnapshotEnvelope extends WsEnvelope {
  type: 'send-queue-snapshot';
  sessionId: string;
  items: SendQueueItem[];
}

export interface RuntimeStateEnvelope extends WsEnvelope, OrchestratorRuntimeSnapshot {
  type: 'runtime-state';
}

export interface SessionReplayEnvelope extends WsEnvelope {
  type: 'session-replay';
  sessionId: string;
  events: SessionReplayItem[];
}

export interface SessionChangedEnvelope extends WsEnvelope {
  type: 'session-changed';
  transition?: SessionTransitionKind;
  session?: unknown;
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

/** Section 4e.3 — per-project envelope fired by `persistAndBroadcast` on
 *  every workflow_runs mutation. Carries the minimum shape needed to drive
 *  the WorkflowDrawer's live-tick without forcing a full refetch. The drawer
 *  re-fetches the full run record for the inspected run on demand. */
export interface WorkflowRunChangedEnvelope {
  type: 'workflow-run-changed';
  projectId: string;
  workflowId: string;
  runId: string;
  status: string;
  nodeOutputs: Record<string, unknown>;
}

// Section 0 phase 0e — supplemental hook events.

export interface NotificationEvent extends ChatEventBase {
  kind: 'notification';
  message: string;
  title?: string | null;
}

export interface SessionEndEvent extends ChatEventBase {
  kind: 'session-end';
  reason?: string | null;
}

export interface SubagentStopEvent extends ChatEventBase {
  kind: 'subagent-stop';
  subagent: string | null;
  result?: string | null;
  /** Section 3 3g — CC's `transcript_path` from the SubagentStop hook payload.
   *  Used by the failure bubble's transcript link to open the right JSONL. */
  transcriptPath?: string | null;
}

/** Section 3 / D10 — emitted by the workflow runtime when a subagent node
 *  terminates with a non-success status. Chat renders a red failure bubble. */
export interface SubagentFailureEvent extends ChatEventBase {
  kind: 'subagent-failure';
  workflowRunId: string;
  nodeId: string;
  agentName: string;
  attemptNumber: number;
  cause:
    | 'agent-self-failed'
    | 'agent-returned-without-closing'
    | 'dispatch-error'
    | 'timeout';
  surfaceError: string;
  transcriptPath?: string | null;
}

// Section 0 phase 0c-followup — fired by CC's StopFailure hook when the
// assistant turn ends via an API error (rate limit, prompt-too-long, auth
// failure). No assistant content lands in the JSONL on this path, so the
// chat panel uses this as a defensive turn-end signal.
export interface StopFailureEvent extends ChatEventBase {
  kind: 'stop-failure';
  text: string;
  error: string;
  errorDetails?: unknown;
}

/** Surface for `type: 'system'` rows from CC's JSONL. Carries the same
 *  message a claude code CLI user would see in their status line. The
 *  chat panel renders it as a muted bubble with the subtype as a tag. */
export interface SystemEvent extends ChatEventBase {
  kind: 'system';
  subtype: string;
  level: string;
  message: string;
  raw: unknown;
}

/** Section 28.6 — CC's queue protocol surfaces in JSONL. A user prompt
 *  submitted while CC is busy lands as `jsonl-queue-enqueue`; when the
 *  slot is consumed (dequeue OR remove on CC ≥2.1) it lands as
 *  `jsonl-queue-dequeue`. Section 0 originally discarded these; 28.6
 *  surfaces them as inline single-line indicators per the buildout doc. */
export interface QueueEvent extends ChatEventBase {
  kind: 'queue-enqueue' | 'queue-dequeue';
  timestamp: string | null;
}

/** Section 31 — session state flips (idle / running / requires_action). Renders
 *  as an inline state-transition divider in chat. Composer enable/disable is
 *  driven separately (31.3) from the latest state value seen in the stream. */
export interface SessionStateEvent extends ChatEventBase {
  kind: 'session-state';
  state: string;
  permissionMode?: string | null;
}

/** Section 31 — auto context-compaction boundary. Renders as a centered
 *  dashed rule with token-freed annotation. */
export interface CompactBoundaryEvent extends ChatEventBase {
  kind: 'compact-boundary';
  trigger?: string | null;
  preTokens?: number | null;
  messagesSummarized?: number | null;
}

/** Section 31 — silent micro-compaction (tool-result cleanup). Renders as an
 *  inline state-transition divider. */
export interface MicrocompactEvent extends ChatEventBase {
  kind: 'microcompact';
  trigger?: string | null;
  preTokens?: number | null;
  tokensSaved?: number | null;
}

/** Section 31 — PM turn footer chips for speed / cache_miss. Synthesized from
 *  jsonl-usage envelopes when the assistant turn carries a non-standard
 *  speed value or a cache-miss reason — both are rare-but-meaningful per the
 *  buildout. Renders as a small chip row beside the preceding assistant
 *  bubble.  */
export interface TurnFooterEvent extends ChatEventBase {
  kind: 'turn-footer';
  speed?: string | null;
  cacheMissReason?: string | null;
  /** Model that produced the chips' source turn. Useful when the speed value
   *  is "slow" because of a forced downgrade. */
  model?: string | null;
}

/** Section 31 — long-running tool progress. Doesn't render as a standalone
 *  bubble; the synthesizer enriches the matching ToolCall by toolUseId and
 *  the tool-group child card shows live elapsed time. */
export interface ToolProgressEvent extends ChatEventBase {
  kind: 'tool-progress';
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number | null;
  taskId: string | null;
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
  | NotificationEvent
  | SessionEndEvent
  | SubagentStopEvent
  | SubagentFailureEvent
  | StopFailureEvent
  | SystemEvent
  | QueueEvent
  | SessionStateEvent
  | CompactBoundaryEvent
  | MicrocompactEvent
  | TurnFooterEvent
  | ToolProgressEvent
  | (ChatEventBase & Record<string, unknown>);

// ── JSONL event shapes (Section 0) ────────────────────────────────────────
// Server emits canonical-source events as `{type:'jsonl', event:{kind,...}}`
// from the per-session JSONL tailer. Mirrors `JsonlEvent` in
// `packages/runtime/src/jsonl-tailer.ts`. Keep in lockstep.

export interface JsonlUserEvent {
  kind: 'jsonl-user';
  text: string;
}

export interface JsonlTurnEndEvent {
  kind: 'jsonl-turn-end';
  text: string;
  stopReason: string;
}

export interface JsonlToolCallEvent {
  kind: 'jsonl-tool-call';
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface JsonlToolResultEvent {
  kind: 'jsonl-tool-result';
  toolUseId: string;
  result: unknown;
  isError: boolean;
}

export interface JsonlQueueEnqueueEvent {
  kind: 'jsonl-queue-enqueue';
  timestamp: string | null;
}

export interface JsonlQueueDequeueEvent {
  kind: 'jsonl-queue-dequeue';
  timestamp: string | null;
}

export interface JsonlSidechainEvent {
  kind: 'jsonl-sidechain';
  raw: unknown;
}

export interface JsonlUsageEvent {
  kind: 'jsonl-usage';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string | null;
  /** Section 31 — `usage.speed` (slow / standard / fast). Renders as a
   *  turn-footer chip when ≠ standard. */
  speed: string | null;
  /** Section 31 — `message.diagnostics.cache_miss_reason`. Renders as a
   *  turn-footer warning chip when a cache miss happens. */
  cacheMissReason: string | null;
}

/** `type: 'system'` rows from CC's JSONL — API errors, init banners, etc.
 *  Whatever a claude code CLI user would have seen in their stderr / status
 *  line, we surface in the chat panel as a system bubble. */
export interface JsonlSystemEvent {
  kind: 'jsonl-system';
  subtype: string;
  level: string;
  message: string;
  timestamp: string | null;
  raw: unknown;
}

// ── Section 31 — kept JSONL signals with typed envelopes ──────────────────

/** CC's auto-generated session title. Drives the left-rail session row title
 *  and the chat title bar. Fires repeatedly as the title is refined. */
export interface JsonlAiTitleEvent {
  kind: 'jsonl-ai-title';
  title: string;
}

/** Leaf pointer (internal). Plumbed for resume correctness; never directly
 *  rendered. */
export interface JsonlLastPromptEvent {
  kind: 'jsonl-last-prompt';
  uuid: string | null;
  raw: unknown;
}

/** Per-message file-state snapshot (internal). Plumbed for "what files did
 *  this session touch"; never directly rendered. */
export interface JsonlFileHistoryEvent {
  kind: 'jsonl-file-history';
  snapshotId: string | null;
  raw: unknown;
}

/** Links session to a `/remote-control` `bridgeSessionId`. Drives the
 *  center-column lower-right remote-control corner indicator. */
export interface JsonlBridgeSessionEvent {
  kind: 'jsonl-bridge-session';
  bridgeSessionId: string | null;
  raw: unknown;
}

/** Long-running tool progress. Renders as a live progress line inside the
 *  tool-group child card. */
export interface JsonlToolProgressEvent {
  kind: 'jsonl-tool-progress';
  toolUseId: string;
  toolName: string;
  parentToolUseId: string | null;
  elapsedSeconds: number | null;
  taskId: string | null;
  raw: unknown;
}

/** Partial assistant tokens for smoother live streaming. */
export interface JsonlStreamEventEnvelope {
  kind: 'jsonl-stream-event';
  event: unknown;
  parentToolUseId: string | null;
  raw: unknown;
}

/** Session state flips. Drives composer enable/disable + inline divider.
 *  Replaces the hook-event scan / sessionEnded heuristic. */
export interface JsonlSessionStateEvent {
  kind: 'jsonl-session-state';
  state: string;
  permissionMode: string | null;
  timestamp: string | null;
  raw: unknown;
}

/** Automatic context compaction boundary. Renders as a centered dashed-rule
 *  in chat. */
export interface JsonlCompactEvent {
  kind: 'jsonl-compact';
  trigger: string | null;
  preTokens: number | null;
  messagesSummarized: number | null;
  timestamp: string | null;
  raw: unknown;
}

/** Silent micro-compaction (tool-result cleanup). Renders as an inline
 *  state-transition divider. */
export interface JsonlMicrocompactEvent {
  kind: 'jsonl-microcompact';
  trigger: string | null;
  preTokens: number | null;
  tokensSaved: number | null;
  timestamp: string | null;
  raw: unknown;
}

/** Completion-time turn duration. Rides the PM bubble timestamp header.
 *  Fires AFTER the preceding `jsonl-turn-end`. */
export interface JsonlTurnDurationEvent {
  kind: 'jsonl-turn-duration';
  durationMs: number | null;
  budgetTokens: number | null;
  messageCount: number | null;
  timestamp: string | null;
  raw: unknown;
}

/** Model-generated post-turn summary. Logged to a per-project table;
 *  render surface TBD per the Section 31 buildout. */
export interface JsonlPostTurnSummaryEvent {
  kind: 'jsonl-post-turn-summary';
  summarizesUuid: string | null;
  statusCategory: string | null;
  statusDetail: string | null;
  isNoteworthy: boolean;
  title: string | null;
  description: string | null;
  recentAction: string | null;
  needsAction: boolean;
  artifactUrls: unknown;
  timestamp: string | null;
  raw: unknown;
}

export type JsonlEvent =
  | JsonlUserEvent
  | JsonlTurnEndEvent
  | JsonlToolCallEvent
  | JsonlToolResultEvent
  | JsonlQueueEnqueueEvent
  | JsonlQueueDequeueEvent
  | JsonlSidechainEvent
  | JsonlUsageEvent
  | JsonlSystemEvent
  | JsonlAiTitleEvent
  | JsonlLastPromptEvent
  | JsonlFileHistoryEvent
  | JsonlBridgeSessionEvent
  | JsonlToolProgressEvent
  | JsonlStreamEventEnvelope
  | JsonlSessionStateEvent
  | JsonlCompactEvent
  | JsonlMicrocompactEvent
  | JsonlTurnDurationEvent
  | JsonlPostTurnSummaryEvent;

// ── Outbound WS messages (Q8 chat send + interrupt + ask-reply) ───────────

export type WsOutbound =
  | { type: 'send'; text: string; clientMessageId?: string }
  | { type: 'interrupt' }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ask-reply'; toolUseId: string; answer: string };

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface UseProjectWsResult {
  events: WsEnvelope[];
  status: WsStatus;
  clear: () => void;
  send: (msg: WsOutbound) => boolean;
  applySessionTransition: (transition: SessionTransitionResponse) => void;
}

// 2026-05-20 — bumped 500 → 10_000 to fix "chat history disappears mid-session"
// (user description: "the entire chat disappears and it looks like a fresh
// session with no history"). PC's chat panel ingests TWO streams per logical
// event (Hook + JSONL tailer), and both halves of every tool call (start +
// end) land here before any dedup. A turn with 30 tool calls is ~150
// envelopes; a few busy turns blew past the prior 500 cap and slid the
// oldest user/assistant entries off the front of the buffer. Refreshing the
// page rehydrates from events.jsonl on disk, which is why the chat came back
// on reload. The 10k ceiling gives multi-hour comfort without the dual-stream
// dedupe refactor.
const MAX_BUFFERED = 10_000;
/** Backoff schedule from legacy `apps/web/legacy/app.js:545` (Session F #4). */
export const RECONNECT_SCHEDULE_MS = [2_000, 5_000, 15_000, 30_000] as const;

function eventTimestamp(env: WsEnvelope): string | null {
  if (env.type !== 'event') return null;
  const inner = (env.event as { ts?: unknown } | undefined) ?? {};
  return typeof inner.ts === 'string' ? inner.ts : null;
}

function replayEventsFromEnvelope(env: WsEnvelope, projectId: string): WsEnvelope[] {
  if (env.type !== 'session-replay') return [];
  const rawEvents = (env as Partial<SessionReplayEnvelope>).events;
  return replayEventsFromItems(rawEvents, projectId);
}

function replayEventsFromItems(rawEvents: unknown, projectId: string): WsEnvelope[] {
  if (!Array.isArray(rawEvents)) return [];
  const out: WsEnvelope[] = [];
  for (const candidate of rawEvents) {
    if (!candidate || typeof candidate !== 'object') continue;
    const type = (candidate as { type?: unknown }).type;
    if (type !== 'jsonl' && type !== 'event') continue;
    out.push({
      projectId,
      type,
      event: (candidate as { event?: unknown }).event,
    });
  }
  return out;
}

function sessionTransitionKind(env: WsEnvelope): SessionTransitionKind | null {
  if (env.type !== 'session-changed') return null;
  const transition = (env as Partial<SessionChangedEnvelope>).transition;
  return transition === 'new-session' || transition === 'resume-session'
    ? transition
    : null;
}

export function nextBackoffMs(prevDelay: number): number {
  const idx = RECONNECT_SCHEDULE_MS.indexOf(prevDelay as (typeof RECONNECT_SCHEDULE_MS)[number]);
  if (idx === -1 || idx === RECONNECT_SCHEDULE_MS.length - 1) return RECONNECT_SCHEDULE_MS[RECONNECT_SCHEDULE_MS.length - 1]!;
  return RECONNECT_SCHEDULE_MS[idx + 1]!;
}

export function useProjectWs(project: Project | null): UseProjectWsResult {
  const [events, setEvents] = useState<WsEnvelope[]>([]);
  const [status, setStatus] = useState<WsStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const seenTsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setEvents([]);
    seenTsRef.current.clear();
    if (!project) {
      setStatus('idle');
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let delay: number = RECONNECT_SCHEDULE_MS[0];

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
          const ts = eventTimestamp(env);
          if (ts) {
            const seenTs = seenTsRef.current;
            if (seenTs.has(ts)) return;
            seenTs.add(ts);
          }
        }
        const final = env;
        // New session is a hard reset. Resume is a soft checkpoint: keep the
        // current buffer visible until the replay snapshot lands.
        if (final.type === 'session-changed') {
          const transition = sessionTransitionKind(final);
          if (transition === 'resume-session') {
            setEvents((prev) => {
              const next = [...prev, final];
              return next.length > MAX_BUFFERED ? next.slice(next.length - MAX_BUFFERED) : next;
            });
          } else {
            seenTsRef.current.clear();
            setEvents([final]);
          }
          return;
        }
        if (final.type === 'session-replay') {
          const replay = replayEventsFromEnvelope(final, project!.id);
          const seenTs = seenTsRef.current;
          seenTs.clear();
          for (const replayEnv of replay) {
            const ts = eventTimestamp(replayEnv);
            if (ts) seenTs.add(ts);
          }
          setEvents((prev) => {
            const latestState = [...prev].reverse().find((candidate) => candidate.type === 'state');
            const latestRuntime = [...prev]
              .reverse()
              .find((candidate) => candidate.type === 'runtime-state');
            const latestSessionChanged = [...prev]
              .reverse()
              .find((candidate) => candidate.type === 'session-changed');
            const checkpoints = [
              ...(latestState ? [latestState] : []),
              ...(latestRuntime ? [latestRuntime] : []),
              ...(latestSessionChanged ? [latestSessionChanged] : []),
            ];
            const replayLimit = Math.max(0, MAX_BUFFERED - checkpoints.length);
            const replaySlice =
              replay.length > replayLimit ? replay.slice(replay.length - replayLimit) : replay;
            return [...checkpoints, ...replaySlice];
          });
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

  const applySessionTransition = useCallback(
    (transition: SessionTransitionResponse): void => {
      if (!project || transition.session.projectId !== project.id) return;

      const replay = replayEventsFromItems(transition.replay, project.id);
      const checkpoint: SessionChangedEnvelope = {
        projectId: project.id,
        type: 'session-changed',
        transition: transition.transition,
        session: transition.session,
      };

      const seenTs = seenTsRef.current;
      seenTs.clear();
      for (const replayEnv of replay) {
        const ts = eventTimestamp(replayEnv);
        if (ts) seenTs.add(ts);
      }

      setEvents((prev) => {
        const latestState = [...prev].reverse().find((candidate) => candidate.type === 'state');
        const latestRuntime = [...prev]
          .reverse()
          .find((candidate) => candidate.type === 'runtime-state');
        const checkpoints = [
          ...(transition.transition === 'resume-session' && latestState ? [latestState] : []),
          ...(transition.transition === 'resume-session' && latestRuntime ? [latestRuntime] : []),
          checkpoint,
        ];
        const replayLimit = Math.max(0, MAX_BUFFERED - checkpoints.length);
        const replaySlice =
          replay.length > replayLimit ? replay.slice(replay.length - replayLimit) : replay;
        return [...checkpoints, ...replaySlice];
      });
    },
    [project],
  );

  return {
    events,
    status,
    clear: () => {
      seenTsRef.current.clear();
      setEvents([]);
    },
    send,
    applySessionTransition,
  };
}
