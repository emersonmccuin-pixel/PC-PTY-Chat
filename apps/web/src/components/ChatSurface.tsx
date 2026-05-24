// Extracted from Orchestrator.tsx — the per-project chat surface that
// renders a live PTY/jsonl event stream as the chat panel the user sees.
// Both <Orchestrator> (live project session) and <AgentDesignerChat>
// (transient agent-designer session) consume this. Wrappers own
// session lifecycle / past-session fetching / status bar; ChatSurface
// owns the actual rendering, composer, thinking indicator, queued-prompt
// UI, and cross-tab scroll-to-bubble plumbing.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type {
  ApprovalRequiredEvent,
  AssistantEvent,
  ChatEvent,
  JsonlEvent,
  SubagentFailureEvent,
  SystemEvent,
  TaskEndEvent,
  TaskStartEvent,
  TodoItem,
  TodosEvent,
  ToolEndEvent,
  ToolStartEvent,
  UserEvent,
  WsEnvelope,
} from '@/hooks/use-project-ws';
import { useAgentTranscript } from '@/store/agent-transcript';
import { useChatScrollTarget } from '@/store/chat-scroll-target';
import { AskCard } from '@/components/AskCard';
import { TranscriptViewer } from '@/components/TranscriptViewer';

// Tools that have their own dedicated bubble surface (Task/Agent → task-start
// + task-end cards; TodoWrite + TaskCreate/Update → todos snapshot card).
// These never enter the generic tool-calls group.
const SUPPRESSED_TOOLS = new Set([
  'Agent',
  'Task',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
  'ToolSearch',
]);

// Tools that get LIFTED OUT of the tool group into their own top-level
// bubbles — the user sees diffs live as the orchestrator works instead of
// having them buried in the collapsed L1 "Tool calls" group.
const HIGHLIGHT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Section 28 / 23 — show EVERY system event in chat. The earlier
// suppression set (stop_hook_summary + turn_duration) violated the
// "render the firehose, learn what's noise" intent. The turn_duration
// `durationMs` value still rides the assistant bubble's "· Ns" suffix —
// that's additive, not a hide.
const SUPPRESSED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set();

// ── Types ─────────────────────────────────────────────────────────────────

interface ToolCall {
  toolUseId: string | null;
  tool: string;
  input: unknown;
  result: unknown;
  startedAt: string;
  ended: boolean;
  stableId: number;
}

interface ToolGroupItem {
  kind: 'tool-group';
  key: string;
  calls: ToolCall[];
}

interface EnvItem {
  kind: 'env';
  key: string;
  env: WsEnvelope;
}

interface EditItem {
  kind: 'edit';
  key: string;
  call: ToolCall;
}

interface WorkflowEventEntry {
  kind: string;
  body: string;
}

interface WorkflowRunGroupItem {
  kind: 'workflow-run-group';
  key: string;
  workflowRunId: string;
  events: WorkflowEventEntry[];
}

interface AgentEventEntry {
  kind: string;
  body: string;
}

interface AgentDispatchGroupItem {
  kind: 'agent-dispatch-group';
  key: string;
  agentRunId: string;
  agentName: string | null;
  events: AgentEventEntry[];
}

type RenderItem =
  | ToolGroupItem
  | EnvItem
  | EditItem
  | WorkflowRunGroupItem
  | AgentDispatchGroupItem;

interface StableEnvelope {
  origIdx: number;
  env: WsEnvelope;
}

// ── JSONL→hook normalization + cross-channel dedupe (Section 0) ──────────

/** Section 23.5 — derive todos snapshots from JSONL tool-calls. Before this
 *  shipped, the hook accumulated state in tasks.json and emitted a full
 *  snapshot per change; client just rendered. Post-23.5 the chat panel owns
 *  derivation: walk the JSONL stream for TodoWrite/TaskCreate/TaskUpdate
 *  tool-call inputs and synthesize a `kind:'todos'` chat-event after each.
 *
 *  TodoWrite carries the full list in `input.todos`. TaskCreate's id rarely
 *  lands in `input` (CC assigns one in the tool response we don't have here);
 *  use the `toolUseId` as the synthesized id — unique per dispatch, stable
 *  across re-renders, irrelevant for the user-facing label. TaskUpdate keys
 *  off `input.taskId` against ids previously seen. */
function injectTodoSnapshots(events: WsEnvelope[]): WsEnvelope[] {
  type Row = { id: string; subject: string; description: string; activeForm: string; status: TodoItem['status'] };
  const state = new Map<string, Row>();
  const out: WsEnvelope[] = [];

  const snapshot = (): TodoItem[] =>
    Array.from(state.values())
      .sort((a, b) => {
        const an = Number(a.id), bn = Number(b.id);
        if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
        return a.id.localeCompare(b.id);
      })
      .map((r) => ({ content: r.subject, activeForm: r.activeForm, status: r.status }));

  for (const env of events) {
    out.push(env);
    if (env.type !== 'jsonl') continue;
    const ev = env.event as JsonlEvent | undefined;
    if (!ev || ev.kind !== 'jsonl-tool-call') continue;
    const input = (ev.input ?? {}) as Record<string, unknown>;
    const name = ev.name;
    let changed = false;
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      state.clear();
      const todos = input.todos as Array<Record<string, unknown>>;
      for (let i = 0; i < todos.length; i++) {
        const t = todos[i] ?? {};
        const id = String(t.id ?? i + 1);
        state.set(id, {
          id,
          subject: String(t.content ?? ''),
          description: '',
          activeForm: String(t.activeForm ?? ''),
          status: (t.status as TodoItem['status']) ?? 'pending',
        });
      }
      changed = true;
    } else if (name === 'TaskCreate') {
      const id = String(input.id ?? ev.toolUseId);
      state.set(id, {
        id,
        subject: String(input.subject ?? ''),
        description: String(input.description ?? ''),
        activeForm: String(input.activeForm ?? ''),
        status: 'pending',
      });
      changed = true;
    } else if (name === 'TaskUpdate') {
      const id = String(input.taskId ?? '');
      if (id) {
        const existing = state.get(id) ?? { id, subject: '', description: '', activeForm: '', status: 'pending' as const };
        state.set(id, {
          ...existing,
          subject: typeof input.subject === 'string' ? input.subject : existing.subject,
          description: typeof input.description === 'string' ? input.description : existing.description,
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : existing.activeForm,
          status: (input.status as TodoItem['status']) ?? existing.status,
        });
        changed = true;
      }
    }
    if (changed) {
      out.push({
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'todos', todos: snapshot() } satisfies TodosEvent,
      });
    }
  }
  return out;
}

/** Convert a jsonl envelope into a hook-shape envelope so the downstream
 *  synthesizer doesn't need to branch on origin. Returns null for jsonl event
 *  kinds that aren't rendered as chat bubbles (queue ops → 0d; sidechain →
 *  Section 6 / Activity panel). */
function normalizeJsonlEnvelope(env: WsEnvelope): WsEnvelope | null {
  if (env.type !== 'jsonl') return env;
  const ev = env.event as JsonlEvent | undefined;
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.kind) {
    case 'jsonl-user':
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'user', text: ev.text },
      };
    case 'jsonl-turn-end':
      // Phase 0c-followup: a user-interrupted turn lands a `stop_reason: null`
      // assistant entry containing only a partial thinking block — no text.
      // Don't synthesize an empty assistant bubble for that; the jsonlBusy
      // derivation (which reads the raw envelope, not the normalized one)
      // still clears the thinking indicator correctly.
      if (!ev.text && ev.stopReason !== 'end_turn') return null;
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'assistant', text: ev.text },
      };
    case 'jsonl-tool-call':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'tool-start',
          tool: ev.name,
          toolUseId: ev.toolUseId,
          input: ev.input,
        },
      };
    case 'jsonl-tool-result':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'tool-end',
          tool: '',
          toolUseId: ev.toolUseId,
          result: ev.result,
        },
      };
    case 'jsonl-system':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'system',
          subtype: ev.subtype,
          level: ev.level,
          message: ev.message,
          raw: ev.raw,
          ts: ev.timestamp ?? undefined,
        } satisfies SystemEvent,
      };
    case 'jsonl-queue-enqueue':
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'queue-enqueue', timestamp: ev.timestamp },
      };
    case 'jsonl-queue-dequeue':
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'queue-dequeue', timestamp: ev.timestamp },
      };
    case 'jsonl-sidechain':
      return null;
    default:
      return null;
  }
}

function synthesizeRenderItems(entries: StableEnvelope[]): RenderItem[] {
  const items: RenderItem[] = [];
  let buffer: ToolCall[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      items.push({ kind: 'tool-group', key: `tg-${buffer[0]!.stableId}`, calls: buffer });
      buffer = [];
    }
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const env = entry.env;
    const stableId = entry.origIdx;
    if (env.type === 'ask') {
      flush();
      items.push({ kind: 'env', key: `env-${stableId}`, env });
      continue;
    }
    if (env.type !== 'event') {
      flush();
      items.push({ kind: 'env', key: `env-${stableId}`, env });
      continue;
    }
    const ev = (env as WsEnvelope & { event: ChatEvent }).event;
    if (!ev || typeof ev !== 'object' || !('kind' in ev)) {
      flush();
      items.push({ kind: 'env', key: `env-${stableId}`, env });
      continue;
    }
    if ((ev.kind === 'tool-start' || ev.kind === 'tool-end') &&
        SUPPRESSED_TOOLS.has((ev as ToolStartEvent | ToolEndEvent).tool)) {
      continue;
    }
    if (ev.kind === 'tool-start') {
      const t = ev as ToolStartEvent;
      const call: ToolCall = {
        toolUseId: t.toolUseId ?? null,
        tool: t.tool,
        input: t.input ?? null,
        result: null,
        startedAt: t.ts ?? `${stableId}`,
        ended: false,
        stableId,
      };
      if (HIGHLIGHT_TOOLS.has(t.tool)) {
        flush();
        items.push({ kind: 'edit', key: `edit-${stableId}`, call });
      } else {
        buffer.push(call);
      }
      continue;
    }
    if (ev.kind === 'tool-end') {
      const t = ev as ToolEndEvent;
      let matched: ToolCall | null = null;
      for (let j = items.length - 1; j >= 0; j--) {
        const it = items[j]!;
        if (it.kind !== 'edit') continue;
        const c = it.call;
        if (c.ended) continue;
        if (t.toolUseId && c.toolUseId === t.toolUseId) { matched = c; break; }
        if (!t.toolUseId && c.tool === t.tool) { matched = c; break; }
      }
      if (!matched && t.toolUseId) {
        for (const c of buffer) {
          if (c.toolUseId === t.toolUseId && !c.ended) { matched = c; break; }
        }
      }
      if (!matched) {
        for (let j = buffer.length - 1; j >= 0; j--) {
          const c = buffer[j]!;
          if (!c.ended && c.tool === t.tool) { matched = c; break; }
        }
      }
      if (!matched) {
        for (let j = items.length - 1; j >= 0; j--) {
          const it = items[j]!;
          if (it.kind === 'edit') continue;
          if (it.kind !== 'tool-group') break;
          for (let k = it.calls.length - 1; k >= 0; k--) {
            const c = it.calls[k]!;
            if (!c.ended && (t.toolUseId ? c.toolUseId === t.toolUseId : c.tool === t.tool)) {
              matched = c; break;
            }
          }
          if (matched) break;
        }
      }
      if (matched) {
        matched.result = t.result ?? null;
        matched.ended = true;
      } else {
        buffer.push({
          toolUseId: t.toolUseId ?? null,
          tool: t.tool,
          input: null,
          result: t.result ?? null,
          startedAt: t.ts ?? `${stableId}`,
          ended: true,
          stableId,
        });
      }
      continue;
    }
    if (ev.kind === 'user') {
      const userText = (ev as UserEvent).text ?? '';
      const parts = parseUserText(userText);
      let hoistedAny = false;
      let hasVisible = false;
      for (const part of parts) {
        if (part.kind === 'workflow-event' && part.workflowRunId) {
          flush();
          const id = part.workflowRunId;
          let group: WorkflowRunGroupItem | null = null;
          for (let j = items.length - 1; j >= 0; j--) {
            const it = items[j]!;
            if (it.kind === 'workflow-run-group' && it.workflowRunId === id) {
              group = it;
              break;
            }
          }
          if (!group) {
            group = {
              kind: 'workflow-run-group',
              key: `wfg-${id}`,
              workflowRunId: id,
              events: [],
            };
            items.push(group);
          }
          group.events.push({
            kind: part.workflowEventKind ?? 'unknown',
            body: part.text,
          });
          hoistedAny = true;
        } else if (part.kind === 'agent-event' && part.agentRunId) {
          flush();
          const id = part.agentRunId;
          let group: AgentDispatchGroupItem | null = null;
          for (let j = items.length - 1; j >= 0; j--) {
            const it = items[j]!;
            if (it.kind === 'agent-dispatch-group' && it.agentRunId === id) {
              group = it;
              break;
            }
          }
          if (!group) {
            group = {
              kind: 'agent-dispatch-group',
              key: `adg-${id}`,
              agentRunId: id,
              agentName: part.agentName ?? null,
              events: [],
            };
            items.push(group);
          } else if (!group.agentName && part.agentName) {
            group.agentName = part.agentName;
          }
          group.events.push({
            kind: part.agentEventKind ?? 'unknown',
            body: part.text,
          });
          hoistedAny = true;
        } else {
          hasVisible = true;
        }
      }
      if (hoistedAny && !hasVisible) {
        continue;
      }
    }
    flush();
    items.push({ kind: 'env', key: `env-${stableId}`, env });
  }
  flush();
  return items;
}

// ── Channel-block parser ─────────────────────────────────────────────────

interface UserPart {
  kind: 'text' | 'channel' | 'workflow-event' | 'agent-event';
  text: string;
  source?: string;
  workflowEventKind?: string;
  workflowRunId?: string;
  agentEventKind?: string;
  agentRunId?: string;
  agentName?: string;
}

const CHANNEL_RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
const WORKFLOW_EVENT_HEADER_RE = /^\[pc:workflow-event\s+kind=([\w-]+)/;
const WORKFLOW_RUN_ID_RE = /\[workflowRunId:\s*([A-Za-z0-9_-]+)\]/;
const AGENT_EVENT_HEADER_RE = /^\[pc:agent-event\s+kind=([\w-]+)/;
const AGENT_RUN_ID_RE = /\[runId:\s*([A-Za-z0-9_-]+)\]/;
const AGENT_NAME_RE = /\[agentName:\s*([\w-]+)\]/;

function parseUserText(text: string): UserPart[] {
  if (!text) return [{ kind: 'text', text: '' }];
  const parts: UserPart[] = [];
  let last = 0;
  let sawChannel = false;
  for (const m of text.matchAll(CHANNEL_RE)) {
    sawChannel = true;
    const idx = m.index ?? 0;
    if (idx > last) {
      const slice = text.slice(last, idx).trim();
      if (slice) parts.push({ kind: 'text', text: slice });
    }
    const attrs = m[1] ?? '';
    const body = (m[2] ?? '').trim();
    last = idx + m[0].length;
    const wfMatch = body.match(WORKFLOW_EVENT_HEADER_RE);
    if (wfMatch) {
      const runMatch = body.match(WORKFLOW_RUN_ID_RE);
      const part: UserPart = {
        kind: 'workflow-event',
        text: body,
        workflowEventKind: wfMatch[1],
      };
      if (runMatch?.[1]) part.workflowRunId = runMatch[1];
      parts.push(part);
      continue;
    }
    const agMatch = body.match(AGENT_EVENT_HEADER_RE);
    if (agMatch) {
      const runMatch = body.match(AGENT_RUN_ID_RE);
      const nameMatch = body.match(AGENT_NAME_RE);
      const part: UserPart = {
        kind: 'agent-event',
        text: body,
        agentEventKind: agMatch[1],
      };
      if (runMatch?.[1]) part.agentRunId = runMatch[1];
      if (nameMatch?.[1]) part.agentName = nameMatch[1];
      parts.push(part);
      continue;
    }
    const sourceMatch = attrs.match(/source\s*=\s*"([^"]+)"/);
    parts.push({ kind: 'channel', text: body, source: sourceMatch?.[1] ?? 'channel' });
  }
  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) parts.push({ kind: 'text', text: tail });
  }
  if (parts.length === 0 && !sawChannel) parts.push({ kind: 'text', text });
  return parts;
}

// ── Approval response (POST to per-project endpoint) ──────────────────────

async function respondToApproval(
  projectId: string,
  workflowRunId: string,
  nodeId: string,
  approved: boolean,
  response: string,
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/approval/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowRunId, nodeId, approved, response }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
}

// ── ChatSurface ──────────────────────────────────────────────────────────

interface ChatSurfaceProps {
  /** Per-project WS-shaped envelope stream (event / jsonl / ask / state / turn-end / etc).
   *  Wrappers adapt their source-of-truth into this shape before passing in. */
  events: WsEnvelope[];
  /** Project id — needed for AskCard reply POST + ApprovalBubble POST. */
  projectId: string;
  /** Current session id (orchestrator PtySession ULID, or null when unknown).
   *  Used to filter `ask` envelopes so transient-session asks don't bleed in. */
  currentSessionId: string | null;
  /** Composer send. Wrappers wire to WS (orchestrator) or HTTP (agent-designer). */
  onSend: (text: string) => boolean;
  /** Composer interrupt. */
  onInterrupt: () => boolean;
  /** Optional ask-card reply (orchestrator only — wires to WS `ask-reply`).
   *  When omitted, ask cards never appear because the session-id filter drops
   *  them; safe to leave undefined for agent-designer surface. */
  onAskReply?: (toolUseId: string, answer: string) => boolean;
  /** localStorage partition for prompt history (per-project / per-surface). */
  composerHistoryKey: string;
  /** Hide composer entirely — past-session view. */
  composerHidden?: boolean;
  /** Disable composer input + send/interrupt buttons. Used for agent-designer
   *  spawn / exited states where the composer is structurally present but
   *  input isn't yet (or no longer) accepted. */
  composerDisabled?: boolean;
  /** Override composer placeholder. Defaults to the orchestrator string. */
  composerPlaceholder?: string;
  /** Optional content above the chat scroller (session title row, agent label, etc.). */
  headerSlot?: ReactNode;
  /** Optional content between scroller and composer (e.g. session-ended notice). */
  bannerSlot?: ReactNode;
  /** Optional content below composer (e.g. StatusBar). */
  footerSlot?: ReactNode;
  /** Content rendered when there are no events to show. */
  emptyState?: ReactNode;
}

export function ChatSurface({
  events,
  projectId,
  currentSessionId,
  onSend,
  onInterrupt,
  onAskReply,
  composerHistoryKey,
  composerHidden,
  composerDisabled,
  composerPlaceholder,
  headerSlot,
  bannerSlot,
  footerSlot,
  emptyState,
}: ChatSurfaceProps) {
  const chatEnvelopes = useMemo<StableEnvelope[]>(() => {
    // Section 23.5 — derive todos snapshots client-side from JSONL tool-calls
    // (replaces the hook-accumulated tasks.json + snapshot emission). The
    // hook no longer accumulates state; the synthetic envelopes injected
    // below carry the same {kind:'todos'} shape as the legacy hook events.
    const eventsWithTodos = injectTodoSnapshots(events);
    // Section 23.8 — buildSuppressionMap retired. Live + new-session replay
    // both source from JSONL; the hook no longer emits user/assistant/
    // tool-start/tool-end (those died in 23.4) so there is no dual-pipe
    // collision to dedupe. Legacy pre-23 sessions surface their hook events
    // verbatim via the legacy events.jsonl fallback in
    // loadSessionReplayEnvelopes; they don't have JSONL counterparts on
    // disk for that session, so dedupe was always a no-op for them too.
    const out: StableEnvelope[] = [];
    for (let i = 0; i < eventsWithTodos.length; i++) {
      const env = eventsWithTodos[i]!;
      if (env.type === 'ask') {
        // Scope ask cards to the owning session — transient sessions broadcast
        // ask envelopes on the same project WS; without this filter their
        // asks bleed in. Permissive when the session id hasn't loaded yet.
        const askSessionId = (env as { sessionId?: string | null }).sessionId;
        if (currentSessionId && askSessionId && askSessionId !== currentSessionId) {
          continue;
        }
        out.push({ origIdx: i, env });
        continue;
      }
      if (env.type === 'event') {
        out.push({ origIdx: i, env });
        continue;
      }
      if (env.type === 'jsonl') {
        const normalized = normalizeJsonlEnvelope(env);
        if (normalized) {
          out.push({ origIdx: i, env: normalized });
        }
      }
    }
    return out;
  }, [events, currentSessionId]);

  const renderItems = useMemo(
    () => synthesizeRenderItems(chatEnvelopes),
    [chatEnvelopes],
  );

  const [resolvedApprovals, setResolvedApprovals] = useState<
    Record<string, { approved: boolean; response: string }>
  >({});
  const [answeredAsks, setAnsweredAsks] = useState<Record<string, string>>({});

  // Thinking indicator state.
  const liveState = useMemo<string | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type === 'turn-end') return 'ready';
      if (env.type === 'state') return (env as WsEnvelope & { state: string }).state;
      if (env.type === 'event') {
        const ev = (env as WsEnvelope & { event: ChatEvent }).event;
        if (ev?.kind === 'stop-failure') return 'ready';
      }
    }
    return null;
  }, [events]);

  const jsonlBusy = useMemo<boolean | null>(() => {
    let anyJsonl = false;
    let busy = false;
    for (const env of events) {
      if (env.type !== 'jsonl') continue;
      const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
      if (!ev || typeof ev !== 'object') continue;
      anyJsonl = true;
      if (ev.kind === 'jsonl-user') busy = true;
      else if (ev.kind === 'jsonl-turn-end') busy = false;
    }
    return anyJsonl ? busy : null;
  }, [events]);

  const isThinking =
    jsonlBusy === null
      ? liveState === 'thinking'
      : jsonlBusy && liveState !== 'ready';

  // Queued-prompt UI (CC's JSONL queue lines don't carry the prompt text;
  // cache locally and pop on dequeue events).
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const dequeueCount = useMemo(() => {
    let n = 0;
    for (const env of events) {
      if (env.type !== 'jsonl') continue;
      const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
      if (ev && ev.kind === 'jsonl-queue-dequeue') n++;
    }
    return n;
  }, [events]);
  const prevDequeueRef = useRef(0);
  useEffect(() => {
    const diff = dequeueCount - prevDequeueRef.current;
    if (diff > 0) setQueuedPrompts((prev) => prev.slice(diff));
    prevDequeueRef.current = dequeueCount;
  }, [dequeueCount]);
  useEffect(() => {
    setQueuedPrompts([]);
    prevDequeueRef.current = 0;
  }, [currentSessionId]);

  // Thinking elapsed timer.
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [interruptedAt, setInterruptedAt] = useState<number | null>(null);
  useEffect(() => {
    if (isThinking) {
      if (thinkingStartedAt === null) {
        setThinkingStartedAt(Date.now());
        setElapsedMs(0);
      }
    } else if (thinkingStartedAt !== null) {
      setThinkingStartedAt(null);
      setElapsedMs(0);
      setInterruptedAt(null);
    }
  }, [isThinking, thinkingStartedAt]);
  useEffect(() => {
    if (thinkingStartedAt === null) return;
    const tick = () => setElapsedMs(Date.now() - thinkingStartedAt);
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [thinkingStartedAt]);

  const handleInterrupt = useCallback((): boolean => {
    const ok = onInterrupt();
    if (ok && isThinking) setInterruptedAt(Date.now());
    return ok;
  }, [onInterrupt, isThinking]);

  const handleSend = useCallback(
    (text: string): boolean => {
      const ok = onSend(text);
      if (ok && isThinking) setQueuedPrompts((prev) => [...prev, text]);
      return ok;
    },
    [onSend, isThinking],
  );

  // Conditional auto-follow + jump-to-recent.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const handleChatScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setPinnedToBottom(distanceFromBottom < 50);
  }, []);
  const jumpToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinnedToBottom(true);
  }, []);
  useEffect(() => {
    if (!pinnedToBottom) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatEnvelopes.length, isThinking, pinnedToBottom]);
  useEffect(() => {
    setPinnedToBottom(true);
  }, [currentSessionId]);

  // Cross-tab scroll-to-bubble (Section 6.5).
  const scrollTargetId = useChatScrollTarget((s) => s.targetId);
  const scrollTargetRequestedAt = useChatScrollTarget((s) => s.requestedAt);
  useEffect(() => {
    if (!scrollTargetId || !scrollTargetRequestedAt) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-bubble-id="${CSS.escape(scrollTargetId)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setPinnedToBottom(false);
    el.classList.add('ring-2', 'ring-warning', 'ring-offset-2', 'ring-offset-background');
    const timer = setTimeout(() => {
      el.classList.remove('ring-2', 'ring-warning', 'ring-offset-2', 'ring-offset-background');
    }, 1500);
    return () => clearTimeout(timer);
  }, [scrollTargetId, scrollTargetRequestedAt]);

  function markApprovalResolved(
    workflowRunId: string,
    nodeId: string,
    approved: boolean,
    response: string,
  ) {
    setResolvedApprovals((prev) => ({
      ...prev,
      [`${workflowRunId}:${nodeId}`]: { approved, response },
    }));
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {headerSlot}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollerRef}
          onScroll={handleChatScroll}
          className="h-full overflow-y-auto px-4 py-3"
        >
          <div className="flex flex-col gap-3">
            {renderItems.map((item, idx) => {
              if (item.kind === 'tool-group') {
                return (
                  <ChatTurnCard key={item.key} kind="pm">
                    <ToolGroupBubble calls={item.calls} />
                  </ChatTurnCard>
                );
              }
              if (item.kind === 'edit') {
                return (
                  <ChatTurnCard key={item.key} kind="pm">
                    <EditBubble call={item.call} />
                  </ChatTurnCard>
                );
              }
              if (item.kind === 'workflow-run-group') {
                return (
                  <ChatTurnCard key={item.key} kind="pm">
                    <WorkflowRunGroupBubble
                      workflowRunId={item.workflowRunId}
                      events={item.events}
                    />
                  </ChatTurnCard>
                );
              }
              if (item.kind === 'agent-dispatch-group') {
                return (
                  <ChatTurnCard key={item.key} kind="pm">
                    <AgentDispatchGroupBubble
                      agentRunId={item.agentRunId}
                      agentName={item.agentName}
                      events={item.events}
                    />
                  </ChatTurnCard>
                );
              }
              const env = item.env;
              let assistantDurationMs: number | undefined;
              if (env.type === 'event') {
                const ev = (env as WsEnvelope & { event: ChatEvent }).event;
                if (ev?.kind === 'assistant') {
                  for (let j = idx + 1; j < renderItems.length; j++) {
                    const next = renderItems[j]!;
                    if (next.kind !== 'env') continue;
                    if (next.env.type !== 'event') continue;
                    const nev = (next.env as WsEnvelope & { event: ChatEvent }).event;
                    if (!nev || typeof nev !== 'object') continue;
                    if (nev.kind === 'user' || nev.kind === 'assistant') break;
                    if (nev.kind === 'system') {
                      const sys = nev as SystemEvent;
                      if (sys.subtype === 'turn_duration') {
                        const raw = sys.raw as { durationMs?: number } | undefined;
                        if (typeof raw?.durationMs === 'number') {
                          assistantDurationMs = raw.durationMs;
                        }
                        break;
                      }
                    }
                  }
                }
              }
              if (env.type === 'ask') {
                const askEnv = env as WsEnvelope & {
                  toolName: string;
                  toolUseId: string;
                  toolInput: unknown;
                };
                const answered = answeredAsks[askEnv.toolUseId];
                return (
                  <ChatTurnCard key={item.key} kind="pm">
                    <AskCard
                      toolName={askEnv.toolName}
                      toolUseId={askEnv.toolUseId}
                      toolInput={askEnv.toolInput}
                      answered={answered}
                      onReply={(answer) => {
                        if (!onAskReply) return;
                        if (onAskReply(askEnv.toolUseId, answer)) {
                          setAnsweredAsks((prev) => ({
                            ...prev,
                            [askEnv.toolUseId]: answer,
                          }));
                        }
                      }}
                    />
                  </ChatTurnCard>
                );
              }
              const ev = (env as WsEnvelope & { event: ChatEvent }).event;
              if (!ev || typeof ev !== 'object') return null;
              // Queue indicators stay as centered markers (not turn cards).
              if (ev.kind === 'queue-enqueue' || ev.kind === 'queue-dequeue') {
                return (
                  <EventBubble
                    key={item.key}
                    event={ev}
                    projectId={projectId}
                    resolvedApprovals={resolvedApprovals}
                    onApprovalResolved={markApprovalResolved}
                  />
                );
              }
              // System non-error footers stay as inline hint text (not turn cards).
              if (ev.kind === 'system') {
                const sys = ev as SystemEvent;
                if (sys.level !== 'error' && !SUPPRESSED_SYSTEM_SUBTYPES.has(sys.subtype)) {
                  return (
                    <EventBubble
                      key={item.key}
                      event={ev}
                      projectId={projectId}
                      resolvedApprovals={resolvedApprovals}
                      onApprovalResolved={markApprovalResolved}
                    />
                  );
                }
              }
              const turnKind: 'user' | 'pm' = ev.kind === 'user' ? 'user' : 'pm';
              let bubbleId: string | undefined;
              if (ev.kind === 'approval-required') {
                const ar = ev as ApprovalRequiredEvent;
                bubbleId = `approval-${ar.workflowRunId}-${ar.nodeId}`;
              }
              return (
                <ChatTurnCard key={item.key} kind={turnKind} bubbleId={bubbleId}>
                  <EventBubble
                    event={ev}
                    projectId={projectId}
                    resolvedApprovals={resolvedApprovals}
                    onApprovalResolved={markApprovalResolved}
                    assistantDurationMs={assistantDurationMs}
                  />
                </ChatTurnCard>
              );
            })}
            {chatEnvelopes.length === 0 && emptyState && (
              <div className="text-center text-xs text-muted-foreground">{emptyState}</div>
            )}
            {isThinking && (
              <ThinkingIndicator elapsedMs={elapsedMs} interruptedAt={interruptedAt} />
            )}
          </div>
        </div>
        {!pinnedToBottom && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-3 right-4 z-10 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground/80 shadow-md hover:bg-accent hover:text-accent-foreground"
            title="Scroll to the latest messages"
          >
            ↓ Jump to recent
          </button>
        )}
      </div>
      {bannerSlot}
      {!composerHidden && (
        <Composer
          historyKey={composerHistoryKey}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          queuedPrompts={queuedPrompts}
          disabled={composerDisabled}
          placeholder={composerPlaceholder}
        />
      )}
      {footerSlot}
    </div>
  );
}

// AskCard reply contract: the parent owns ask reply (WS send for orchestrator,
// not applicable for agent-designer surface). To preserve that contract while
// keeping ChatSurface composable, we expose an internal hook the wrapper sets
// via context — but for now, since Orchestrator is the ONLY surface emitting
// asks, we route ask-reply through a callback prop. Add to ChatSurfaceProps.

// ── Chat turn card (Glass surface, Section 29) ───────────────────────────

function ChatTurnCard({
  kind,
  children,
  bubbleId,
}: {
  kind: 'user' | 'pm';
  children: React.ReactNode;
  bubbleId?: string;
}) {
  return (
    <div
      className={`chat-turn${kind === 'user' ? ' chat-turn-user' : ''}`}
      data-bubble-id={bubbleId}
    >
      {children}
    </div>
  );
}

// ── Bubble dispatch ──────────────────────────────────────────────────────

interface EventBubbleProps {
  event: ChatEvent;
  projectId: string;
  resolvedApprovals: Record<string, { approved: boolean; response: string }>;
  onApprovalResolved: (
    workflowRunId: string,
    nodeId: string,
    approved: boolean,
    response: string,
  ) => void;
  assistantDurationMs?: number;
}

function EventBubble({
  event,
  projectId,
  resolvedApprovals,
  onApprovalResolved,
  assistantDurationMs,
}: EventBubbleProps) {
  switch (event.kind) {
    case 'user':
      return <UserBubble event={event as UserEvent} />;
    case 'assistant':
      return (
        <AssistantBubble event={event as AssistantEvent} durationMs={assistantDurationMs} />
      );
    case 'tool-start':
    case 'tool-end':
      return null;
    case 'todos':
      return <TodosBubble event={event as TodosEvent} />;
    case 'task-start':
      return <TaskStartBubble event={event as TaskStartEvent} />;
    case 'task-end':
      return <TaskEndBubble event={event as TaskEndEvent} />;
    case 'approval-required':
      return (
        <ApprovalBubble
          event={event as ApprovalRequiredEvent}
          projectId={projectId}
          resolved={
            resolvedApprovals[
              `${(event as ApprovalRequiredEvent).workflowRunId}:${(event as ApprovalRequiredEvent).nodeId}`
            ]
          }
          onResolved={onApprovalResolved}
        />
      );
    case 'subagent-failure':
      return <FailureBubble event={event as SubagentFailureEvent} />;
    case 'system': {
      const sys = event as SystemEvent;
      if (SUPPRESSED_SYSTEM_SUBTYPES.has(sys.subtype)) return null;
      return <SystemBubble event={sys} />;
    }
    case 'queue-enqueue':
      return <QueueIndicator text="queued" />;
    case 'queue-dequeue':
      return <QueueIndicator text="dequeued" />;
    case 'session-end':
    case 'subagent-stop':
      return null;
    default:
      return null;
  }
}

function QueueIndicator({ text }: { text: string }) {
  return (
    <div className="self-center px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
      · {text} ·
    </div>
  );
}

// ── Subagent failure bubble ───────────────────────────────────────────────

const FAILURE_CAUSE_LABEL: Record<SubagentFailureEvent['cause'], string> = {
  'agent-self-failed': 'Agent reported failure',
  'agent-returned-without-closing': 'Agent did not close the node',
  'dispatch-error': 'Dispatch failed',
  timeout: 'Timed out',
};

function FailureBubble({ event }: { event: SubagentFailureEvent }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  return (
    <div className="self-start max-w-[85%] border border-destructive/60 bg-destructive/5 px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-destructive px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive-foreground">
          subagent failed
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{event.agentName}</span>
        <span className="text-[10px] text-muted-foreground">
          {FAILURE_CAUSE_LABEL[event.cause] ?? event.cause}
          {event.attemptNumber > 1 ? ` · attempt ${event.attemptNumber}` : ''}
        </span>
      </div>
      <div className="mb-1.5 whitespace-pre-wrap break-words text-sm text-foreground">
        {event.surfaceError || '(no surface error provided)'}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-mono">
          run={event.workflowRunId.slice(0, 12)} · node={event.nodeId}
        </span>
        {event.transcriptPath ? (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="border border-border px-2 py-0.5 text-[10px] hover:bg-muted"
          >
            View transcript
          </button>
        ) : (
          <span className="italic">no transcript captured</span>
        )}
      </div>
      {viewerOpen && event.transcriptPath && (
        <TranscriptViewer
          path={event.transcriptPath}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}

// ── System bubble / footer ───────────────────────────────────────────────

function SystemBubble({ event }: { event: SystemEvent }) {
  if (event.level === 'error') return <SystemErrorBubble event={event} />;
  return <SystemFooter event={event} />;
}

function SystemErrorBubble({ event }: { event: SystemEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="self-start max-w-[85%] border border-destructive/60 bg-destructive/5 px-3 py-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-destructive px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive-foreground">
          {event.subtype.replace(/_/g, ' ')}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {event.level}
        </span>
        {event.ts && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {new Date(event.ts).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words text-sm text-foreground">
        {event.message}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground underline-offset-2 hover:underline"
      >
        {open ? 'Hide details' : 'Show details'}
      </button>
      {open && <SystemRawDump raw={event.raw} />}
    </div>
  );
}

function SystemFooter({ event }: { event: SystemEvent }) {
  const [open, setOpen] = useState(false);
  const previewRaw = event.message.startsWith(`[${event.subtype}]`)
    ? event.message.slice(`[${event.subtype}]`.length).trim()
    : event.message;
  const preview = previewRaw.split('\n')[0] ?? '';
  const hasMore = previewRaw !== preview || event.raw !== undefined;
  return (
    <div className="self-start max-w-[90%] text-[11px] text-muted-foreground">
      <button
        type="button"
        onClick={() => hasMore && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 text-left ${hasMore ? 'hover:text-foreground' : 'cursor-default'}`}
      >
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
          {event.subtype.replace(/_/g, ' ')}
        </span>
        <span className="min-w-0 flex-1 truncate italic">{preview}</span>
        {hasMore && (
          <span className="shrink-0 text-[10px] uppercase tracking-wider underline-offset-2 hover:underline">
            {open ? 'hide' : 'details'}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-3">
          {previewRaw !== preview && (
            <div className="mb-1.5 whitespace-pre-wrap break-words text-foreground">
              {previewRaw}
            </div>
          )}
          <SystemRawDump raw={event.raw} />
        </div>
      )}
    </div>
  );
}

function SystemRawDump({ raw }: { raw: unknown }) {
  return (
    <pre className="mt-1.5 max-h-64 overflow-auto border border-border bg-background p-2 font-mono text-[10px] leading-snug">
      {(() => {
        try {
          return JSON.stringify(raw, null, 2);
        } catch {
          return String(raw);
        }
      })()}
    </pre>
  );
}

// ── Thinking indicator ───────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}

function ThinkingIndicator({
  elapsedMs,
  interruptedAt,
}: {
  elapsedMs: number;
  interruptedAt: number | null;
}) {
  const [sinceInterrupt, setSinceInterrupt] = useState(0);
  useEffect(() => {
    if (interruptedAt === null) {
      setSinceInterrupt(0);
      return;
    }
    const tick = () => setSinceInterrupt(Date.now() - interruptedAt);
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [interruptedAt]);

  const interrupting = interruptedAt !== null;
  const stuck = interrupting && sinceInterrupt > 5_000;
  return (
    <div
      className={
        'self-start flex flex-col gap-1 border px-3 py-1.5 text-xs ' +
        (interrupting
          ? 'border-warning/60 bg-warning/10 text-warning'
          : 'border-border bg-card text-muted-foreground')
      }
    >
      <div className="flex items-center gap-2">
        <span className="thinking-dots inline-flex items-center gap-0.5">
          <span className="thinking-dot" />
          <span className="thinking-dot" />
          <span className="thinking-dot" />
        </span>
        <span>{interrupting ? 'Interrupting' : 'Thinking'}</span>
        <span className="font-mono tabular-nums opacity-80">
          {interrupting ? formatElapsed(sinceInterrupt) : formatElapsed(elapsedMs)}
        </span>
      </div>
      {stuck && (
        <div className="text-[10px] uppercase tracking-wider opacity-90">
          Claude isn't responding to the interrupt — click it again, or use "+ New session" if stuck.
        </div>
      )}
    </div>
  );
}

// ── Copy-to-clipboard ─────────────────────────────────────────────────────

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {
            /* clipboard unavailable */
          });
      }}
      title="Copy to clipboard"
      className="absolute right-1 top-1 hidden border border-border bg-card/90 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground group-hover:block"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

// ── Role tab ──────────────────────────────────────────────────────────────

function RoleTab({ role, suffix }: { role: 'user' | 'claude'; suffix?: string }) {
  const text = role === 'user' ? 'You' : 'Claude';
  const styles =
    role === 'user'
      ? 'border-primary/60 bg-primary/30 text-primary/90'
      : 'border-border bg-card text-muted-foreground';
  return (
    <div
      className={`relative z-10 -mb-px inline-block border border-b-0 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${styles}`}
    >
      {text}
      {suffix && <span className="ml-1.5 font-mono normal-case opacity-70">· {suffix}</span>}
    </div>
  );
}

// ── User bubble ──────────────────────────────────────────────────────────

function UserBubble({ event }: { event: UserEvent }) {
  const parts = useMemo(() => {
    const all = parseUserText(event.text ?? '');
    return all.filter((p) => p.kind !== 'workflow-event' && p.kind !== 'agent-event');
  }, [event.text]);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part, idx) =>
        part.kind === 'channel' ? (
          <div
            key={idx}
            className="group relative self-start max-w-[85%] border border-warning/60 bg-warning/5 px-3 py-2 text-sm"
          >
            <div className="mb-1 text-[10px] uppercase tracking-wider text-warning">
              channel · {part.source}
            </div>
            <div className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {part.text || '(empty body)'}
            </div>
            <CopyButton text={part.text} />
          </div>
        ) : (
          <div key={idx} className="group">
            <RoleTab role="user" />
            <div className="relative border border-primary/60 bg-primary/30 px-3 py-2 text-sm text-foreground">
              <div className="whitespace-pre-wrap break-words">
                {part.text || '(empty prompt)'}
              </div>
              <CopyButton text={part.text} />
            </div>
          </div>
        ),
      )}
    </>
  );
}

// ── Assistant bubble ─────────────────────────────────────────────────────

function AssistantBubble({
  event,
  durationMs,
}: {
  event: AssistantEvent;
  durationMs?: number;
}) {
  const text = event.text ?? '';
  const durationSuffix = typeof durationMs === 'number' ? formatElapsed(durationMs) : undefined;
  if (!text) {
    return (
      <div>
        <RoleTab role="claude" suffix={durationSuffix} />
        <div className="border border-border bg-card px-3 py-2 text-sm italic text-muted-foreground">
          {event.transcriptPath
            ? `(no assistant text — transcript empty or missing at ${event.transcriptPath})`
            : '(no transcript path provided by Stop hook)'}
        </div>
      </div>
    );
  }
  return (
    <div className="group">
      <RoleTab role="claude" suffix={durationSuffix} />
      <div className="relative border border-border bg-card px-3 py-2 text-sm text-foreground">
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
        </div>
        <CopyButton text={text} />
      </div>
    </div>
  );
}

// ── Tool-calls group ─────────────────────────────────────────────────────

function summarizeInput(tool: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return typeof i.file_path === 'string'
        ? (i.file_path as string)
        : typeof i.notebook_path === 'string'
          ? (i.notebook_path as string)
          : '';
    case 'Bash':
    case 'PowerShell': {
      const cmd = typeof i.command === 'string' ? (i.command as string) : '';
      const first = cmd.split('\n')[0] ?? '';
      return first.length > 80 ? first.slice(0, 80) + '…' : first;
    }
    case 'Glob':
      return typeof i.pattern === 'string' ? (i.pattern as string) : '';
    case 'Grep': {
      const p = typeof i.pattern === 'string' ? (i.pattern as string) : '';
      const g = typeof i.glob === 'string' ? ` · ${i.glob}` : '';
      return p + g;
    }
    case 'WebFetch':
      return typeof i.url === 'string' ? (i.url as string) : '';
    case 'WebSearch':
      return typeof i.query === 'string' ? (i.query as string) : '';
    default:
      return '';
  }
}

function resultToString(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function ToolCallDetails({ call }: { call: ToolCall }) {
  const inputStr = useMemo(() => {
    if (call.input == null) return '';
    if (typeof call.input === 'string') return call.input;
    try {
      return JSON.stringify(call.input, null, 2);
    } catch {
      return String(call.input);
    }
  }, [call.input]);
  const resultStr = resultToString(call.result);
  const isEdit = call.tool === 'Edit' && call.input && typeof call.input === 'object';
  const isWrite = call.tool === 'Write' && call.input && typeof call.input === 'object';
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2">
      {isEdit ? (
        <EditDiff input={call.input as Record<string, unknown>} />
      ) : isWrite ? (
        <WritePreview input={call.input as Record<string, unknown>} />
      ) : inputStr ? (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            input
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-1.5 font-mono text-[11px] text-foreground">
            {inputStr}
          </pre>
        </div>
      ) : null}
      {call.ended ? (
        resultStr ? (
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              result
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-1.5 font-mono text-[11px] text-foreground">
              {resultStr}
            </pre>
          </div>
        ) : (
          <div className="text-[11px] italic text-muted-foreground">(no result text)</div>
        )
      ) : (
        <div className="text-[11px] italic text-muted-foreground">running…</div>
      )}
    </div>
  );
}

function EditBubble({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const input = (call.input ?? {}) as Record<string, unknown>;
  const path =
    typeof input.file_path === 'string'
      ? (input.file_path as string)
      : typeof input.notebook_path === 'string'
        ? (input.notebook_path as string)
        : '';
  const running = !call.ended;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-muted-foreground hover:text-foreground"
      >
        <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
        <span className="font-medium uppercase tracking-wider">{call.tool}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
          title={path}
        >
          {path || '(no path)'}
        </span>
        {running ? (
          <span className="thinking-dots inline-flex shrink-0 items-center gap-0.5">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] text-success">✓</span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 border border-border bg-card px-3 py-2">
          <ToolCallDetails call={call} />
        </div>
      )}
    </div>
  );
}

function EditDiff({ input }: { input: Record<string, unknown> }) {
  const path = typeof input.file_path === 'string' ? (input.file_path as string) : '';
  const oldStr = typeof input.old_string === 'string' ? (input.old_string as string) : '';
  const newStr = typeof input.new_string === 'string' ? (input.new_string as string) : '';
  return (
    <div className="flex flex-col gap-1">
      {path && (
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          edit · {path}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border border-destructive/40 bg-destructive/5 p-1.5 font-mono text-[11px] text-foreground">
          {oldStr || '(empty)'}
        </pre>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border border-success/40 bg-success/5 p-1.5 font-mono text-[11px] text-foreground">
          {newStr || '(empty)'}
        </pre>
      </div>
    </div>
  );
}

function WritePreview({ input }: { input: Record<string, unknown> }) {
  const path = typeof input.file_path === 'string' ? (input.file_path as string) : '';
  const content = typeof input.content === 'string' ? (input.content as string) : '';
  return (
    <div className="flex flex-col gap-1">
      {path && (
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          write · {path}
        </div>
      )}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-success/40 bg-success/5 p-1.5 font-mono text-[11px] text-foreground">
        {content || '(empty)'}
      </pre>
    </div>
  );
}

function ExpandCollapseChips({
  onExpandAll,
  onCollapseAll,
  scope,
}: {
  onExpandAll: () => void;
  onCollapseAll: () => void;
  scope: string;
}) {
  return (
    <div className="flex gap-1 text-[10px] uppercase tracking-wider">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onExpandAll();
        }}
        className="border border-border bg-background px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        title={`Expand every ${scope}`}
      >
        expand all
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCollapseAll();
        }}
        className="border border-border bg-background px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        title={`Collapse every ${scope}`}
      >
        collapse all
      </button>
    </div>
  );
}

function ToolCallRow({
  call,
  open,
  onToggle,
}: {
  call: ToolCall;
  open: boolean;
  onToggle: () => void;
}) {
  const summary = summarizeInput(call.tool, call.input);
  return (
    <div className="border-l border-border pl-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
        <span className="font-medium text-foreground">{call.tool}</span>
        {summary && <span className="truncate font-mono text-[11px] text-muted-foreground">{summary}</span>}
        {!call.ended && (
          <span className="ml-auto text-[10px] italic text-warning">running…</span>
        )}
      </button>
      {open && <ToolCallDetails call={call} />}
    </div>
  );
}

function ToolSubgroup({
  tool,
  calls,
  open,
  onToggle,
  onExpandAll,
  onCollapseAll,
  isRowOpen,
  toggleRow,
}: {
  tool: string;
  calls: ToolCall[];
  open: boolean;
  onToggle: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  isRowOpen: (c: ToolCall) => boolean;
  toggleRow: (c: ToolCall) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-baseline gap-1.5 text-left text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
          <span>{tool}</span>
          <span className="text-muted-foreground/70">({calls.length})</span>
        </button>
        {open && calls.length > 1 && (
          <ExpandCollapseChips
            onExpandAll={onExpandAll}
            onCollapseAll={onCollapseAll}
            scope={`${tool} call`}
          />
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-1 pl-3">
          {calls.map((c, i) => (
            <ToolCallRow
              key={`${c.toolUseId ?? c.startedAt}-${i}`}
              call={c}
              open={isRowOpen(c)}
              onToggle={() => toggleRow(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type EventGroupStatusTone = 'info' | 'warning' | 'success' | 'error';

function CollapsibleEventGroup({
  label,
  count,
  status,
  controls,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number | string;
  status?: { text: string; tone?: EventGroupStatusTone };
  controls?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const toneCls: Record<EventGroupStatusTone, string> = {
    info: 'text-muted-foreground',
    warning: 'text-warning',
    success: 'text-success',
    error: 'text-destructive',
  };
  const tone = status?.tone ?? 'info';
  return (
    <div className="self-start max-w-[85%] border border-border bg-card px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-baseline gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
          <span className="font-medium uppercase tracking-wider text-foreground">{label}</span>
          {count !== undefined && (
            <span className="text-muted-foreground/70">({count})</span>
          )}
          {status && (
            <span className={`text-[10px] italic ${toneCls[tone]}`}>· {status.text}</span>
          )}
        </button>
        {open && controls}
      </div>
      {open && <div className="mt-2 flex flex-col gap-2">{children}</div>}
    </div>
  );
}

function ToolGroupBubble({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const [rowsOpen, setRowsOpen] = useState<Record<string, boolean>>({});
  const [subgroupsOpen, setSubgroupsOpen] = useState<Record<string, boolean>>({});

  const byTool = useMemo(() => {
    const map = new Map<string, ToolCall[]>();
    for (const c of calls) {
      const list = map.get(c.tool) ?? [];
      list.push(c);
      map.set(c.tool, list);
    }
    return Array.from(map.entries());
  }, [calls]);

  const total = calls.length;
  const running = calls.filter((c) => !c.ended).length;

  const rowKey = (c: ToolCall) => `${c.toolUseId ?? c.startedAt}`;
  const isRowOpen = (c: ToolCall) => {
    const k = rowKey(c);
    return k in rowsOpen ? rowsOpen[k]! : false;
  };
  const toggleRow = (c: ToolCall) => {
    const k = rowKey(c);
    setRowsOpen((prev) => ({ ...prev, [k]: !isRowOpen(c) }));
  };
  const isSubgroupOpen = (tool: string) =>
    tool in subgroupsOpen ? subgroupsOpen[tool]! : true;
  const toggleSubgroup = (tool: string) =>
    setSubgroupsOpen((prev) => ({ ...prev, [tool]: !isSubgroupOpen(tool) }));

  function expandAll() {
    setOpen(true);
    const r: Record<string, boolean> = {};
    const s: Record<string, boolean> = {};
    for (const c of calls) {
      r[rowKey(c)] = true;
      s[c.tool] = true;
    }
    setRowsOpen(r);
    setSubgroupsOpen(s);
  }
  function collapseAll() {
    const r: Record<string, boolean> = {};
    const s: Record<string, boolean> = {};
    for (const c of calls) {
      r[rowKey(c)] = false;
      s[c.tool] = false;
    }
    setRowsOpen(r);
    setSubgroupsOpen(s);
  }
  function expandSubgroup(tool: string) {
    setSubgroupsOpen((prev) => ({ ...prev, [tool]: true }));
    setRowsOpen((prev) => {
      const next = { ...prev };
      for (const c of calls) if (c.tool === tool) next[rowKey(c)] = true;
      return next;
    });
  }
  function collapseSubgroup(tool: string) {
    setRowsOpen((prev) => {
      const next = { ...prev };
      for (const c of calls) if (c.tool === tool) next[rowKey(c)] = false;
      return next;
    });
  }

  return (
    <CollapsibleEventGroup
      label="Tool calls"
      count={total}
      status={running > 0 ? { text: `${running} running`, tone: 'warning' } : undefined}
      controls={
        <ExpandCollapseChips
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          scope="call"
        />
      }
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {byTool.map(([tool, list]) => (
        <ToolSubgroup
          key={tool}
          tool={tool}
          calls={list}
          open={isSubgroupOpen(tool)}
          onToggle={() => toggleSubgroup(tool)}
          onExpandAll={() => expandSubgroup(tool)}
          onCollapseAll={() => collapseSubgroup(tool)}
          isRowOpen={isRowOpen}
          toggleRow={toggleRow}
        />
      ))}
    </CollapsibleEventGroup>
  );
}

// ── Workflow-run group bubble (Section 28.3) ─────────────────────────────

const WORKFLOW_TERMINATED_STATUS_RE = /status="(\w+)"/;

function deriveWorkflowStatus(events: WorkflowEventEntry[]):
  | { text: string; tone?: EventGroupStatusTone }
  | undefined {
  if (events.length === 0) return undefined;
  const last = events[events.length - 1]!;
  if (last.kind === 'terminated') {
    const m = last.body.match(WORKFLOW_TERMINATED_STATUS_RE);
    const s = m?.[1];
    if (s === 'complete') return { text: 'completed', tone: 'success' };
    if (s === 'failed') return { text: 'failed', tone: 'error' };
    if (s === 'cancelled') return { text: 'cancelled' };
    return { text: 'ended' };
  }
  if (last.kind === 'orchestrator-review') return { text: 'awaiting review', tone: 'warning' };
  return { text: 'running', tone: 'warning' };
}

function WorkflowRunGroupBubble({
  workflowRunId,
  events,
}: {
  workflowRunId: string;
  events: WorkflowEventEntry[];
}) {
  const [open, setOpen] = useState(false);
  const status = deriveWorkflowStatus(events);
  return (
    <CollapsibleEventGroup
      label="Workflow run"
      count={`${events.length} ${events.length === 1 ? 'event' : 'events'}`}
      status={status}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        run {workflowRunId}
      </div>
      {events.map((ev, i) => (
        <div key={i} className="border-l border-border pl-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {ev.kind}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {ev.body}
          </pre>
        </div>
      ))}
    </CollapsibleEventGroup>
  );
}

// ── Agent-dispatch group bubble (Section 28.4) ───────────────────────────

const AGENT_CAUSE_RE = /\[cause:\s*([\w-]+)\]/;
const AGENT_VERIFICATION_RE = /\[verification:\s*(\w+)\]/;

function deriveAgentStatus(events: AgentEventEntry[]):
  | { text: string; tone?: EventGroupStatusTone }
  | undefined {
  if (events.length === 0) return undefined;
  const last = events[events.length - 1]!;
  switch (last.kind) {
    case 'agent-completed': {
      const v = last.body.match(AGENT_VERIFICATION_RE)?.[1];
      if (v === 'failed') return { text: 'completed · verify failed', tone: 'error' };
      if (v === 'pending') return { text: 'completed · review pending', tone: 'warning' };
      return { text: 'completed', tone: 'success' };
    }
    case 'agent-failed': {
      const cause = last.body.match(AGENT_CAUSE_RE)?.[1];
      return { text: cause ? `failed (${cause})` : 'failed', tone: 'error' };
    }
    case 'agent-asks-orchestrator':
      return { text: 'awaiting orchestrator', tone: 'warning' };
    case 'agent-asks-user':
      return { text: 'awaiting user', tone: 'warning' };
    case 'agent-approval-request':
      return { text: 'awaiting approval', tone: 'warning' };
    case 'agent-queued-started':
      return { text: 'running', tone: 'warning' };
    default:
      return { text: 'running', tone: 'warning' };
  }
}

function AgentDispatchGroupBubble({
  agentRunId,
  agentName,
  events,
}: {
  agentRunId: string;
  agentName: string | null;
  events: AgentEventEntry[];
}) {
  const [open, setOpen] = useState(false);
  const status = deriveAgentStatus(events);
  const label = agentName ? `Agent · ${agentName}` : 'Agent';
  const openTranscript = useAgentTranscript((s) => s.open);
  return (
    <CollapsibleEventGroup
      label={label}
      count={`${events.length} ${events.length === 1 ? 'event' : 'events'}`}
      status={status}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          run {agentRunId}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openTranscript(agentRunId);
          }}
          className="shrink-0 border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          View transcript
        </button>
      </div>
      {events.map((ev, i) => (
        <div key={i} className="border-l border-border pl-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {ev.kind}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {ev.body}
          </pre>
        </div>
      ))}
    </CollapsibleEventGroup>
  );
}

// ── Todos card ───────────────────────────────────────────────────────────

function TodosBubble({ event }: { event: TodosEvent }) {
  const todos = event.todos ?? [];
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="self-start max-w-[85%] border border-border bg-card px-3 py-2 text-sm">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        Working on ({done}/{todos.length})
      </div>
      <ul className="flex flex-col gap-1">
        {todos.map((t, i) => {
          const status = t.status ?? 'pending';
          const dot = status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○';
          const text =
            status === 'in_progress' && t.activeForm ? t.activeForm : (t.content ?? '(blank)');
          const cls =
            status === 'completed'
              ? 'text-muted-foreground line-through'
              : status === 'in_progress'
                ? 'text-foreground'
                : 'text-muted-foreground';
          return (
            <li key={i} className={`flex items-baseline gap-2 text-sm ${cls}`}>
              <span className="w-4 text-center text-xs">{dot}</span>
              <span className="break-words">{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Task delegation bubbles ──────────────────────────────────────────────

function TaskStartBubble({ event }: { event: TaskStartEvent }) {
  return (
    <div className="self-start max-w-[85%] border-l-2 border-accent bg-card px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent-foreground">
          {event.subagent || 'subagent'}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          delegated
        </span>
      </div>
      {event.description && (
        <div className="text-sm text-foreground">{event.description}</div>
      )}
    </div>
  );
}

function TaskEndBubble({ event }: { event: TaskEndEvent }) {
  const text = event.result ?? '';
  return (
    <div className="group relative self-start max-w-[85%] border-l-2 border-success bg-card px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-success px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-background">
          {event.subagent || 'subagent'}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          returned
        </span>
      </div>
      {text ? (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
        </div>
      ) : (
        <div className="text-sm italic text-muted-foreground">(no result text)</div>
      )}
      {text && <CopyButton text={text} />}
    </div>
  );
}

// ── Approval card ────────────────────────────────────────────────────────

interface ApprovalBubbleProps {
  event: ApprovalRequiredEvent;
  projectId: string;
  resolved?: { approved: boolean; response: string };
  onResolved: (
    workflowRunId: string,
    nodeId: string,
    approved: boolean,
    response: string,
  ) => void;
}

function ApprovalBubble({ event, projectId, resolved, onResolved }: ApprovalBubbleProps) {
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(approved: boolean, response: string) {
    setBusy(true);
    setError(null);
    try {
      await respondToApproval(projectId, event.workflowRunId, event.nodeId, approved, response);
      onResolved(event.workflowRunId, event.nodeId, approved, response);
    } catch (err) {
      setError(`Failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-bubble-id={`approval-${event.workflowRunId}-${event.nodeId}`}
      className="self-start max-w-[85%] border border-warning/60 bg-card px-3 py-2 text-sm"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-warning px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-background">
          approval required
        </span>
      </div>
      <div className="mb-2 text-sm text-foreground">{event.message ?? '(no message)'}</div>
      {resolved ? (
        <div className="text-xs text-muted-foreground">
          {resolved.approved
            ? 'Approved.'
            : `Rejected${resolved.response ? ` — ${resolved.response}` : ''}.`}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit(true, '')}
              className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowReject(true)}
              className="bg-destructive px-3 py-1 text-xs font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
          {showReject && (
            <div className="flex flex-col gap-1">
              {event.on_reject_prompt && (
                <div className="text-xs text-muted-foreground">{event.on_reject_prompt}</div>
              )}
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder={event.on_reject_prompt ?? 'Optional reason'}
                className="border border-border bg-background px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit(false, reason)}
                className="self-start bg-destructive px-3 py-1 text-xs font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                Submit reject
              </button>
            </div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
      )}
    </div>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────

const PROMPT_HISTORY_CAP = 100;

function historyStorageKey(key: string) {
  return `pc:prompt-history:${key}`;
}

function readHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(historyStorageKey(key));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function writeHistory(key: string, list: string[]) {
  try {
    localStorage.setItem(historyStorageKey(key), JSON.stringify(list));
  } catch {
    /* quota / disabled storage — best effort */
  }
}

function Composer({
  historyKey,
  onSend,
  onInterrupt,
  queuedPrompts,
  disabled,
  placeholder,
}: {
  historyKey: string;
  onSend: (text: string) => boolean;
  onInterrupt: () => boolean;
  queuedPrompts: string[];
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [interruptFeedback, setInterruptFeedback] = useState<'sent' | 'failed' | null>(null);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const COMPOSER_MIN_PX = 56;
  const COMPOSER_MAX_PX = 200;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.max(COMPOSER_MIN_PX, Math.min(el.scrollHeight, COMPOSER_MAX_PX));
    el.style.height = `${next}px`;
  }, []);
  useEffect(() => { resizeTextarea(); }, [text, resizeTextarea]);

  function clickInterrupt() {
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
    const ok = onInterrupt();
    setInterruptFeedback(ok ? 'sent' : 'failed');
    interruptTimerRef.current = setTimeout(() => setInterruptFeedback(null), 1500);
  }
  useEffect(() => () => {
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
  }, []);

  const historyRef = useRef<string[]>(readHistory(historyKey));
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);

  useEffect(() => {
    historyRef.current = readHistory(historyKey);
    setHistoryIdx(null);
    setText('');
  }, [historyKey]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (onSend(trimmed)) {
      const hist = historyRef.current;
      if (hist[hist.length - 1] !== trimmed) {
        hist.push(trimmed);
        if (hist.length > PROMPT_HISTORY_CAP) hist.splice(0, hist.length - PROMPT_HISTORY_CAP);
        writeHistory(historyKey, hist);
      }
      setHistoryIdx(null);
      setText('');
    }
  }

  function navHistory(direction: -1 | 1) {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (direction === -1) {
      const next = historyIdx === null ? hist.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setText(hist[next] ?? '');
    } else {
      if (historyIdx === null) return;
      const next = historyIdx + 1;
      if (next >= hist.length) {
        setHistoryIdx(null);
        setText('');
      } else {
        setHistoryIdx(next);
        setText(hist[next] ?? '');
      }
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-card px-4 py-3">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (historyIdx !== null) setHistoryIdx(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
            return;
          }
          if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            if (text === '' || historyIdx !== null) {
              e.preventDefault();
              navHistory(-1);
            }
            return;
          }
          if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            if (historyIdx !== null) {
              e.preventDefault();
              navHistory(1);
            }
            return;
          }
        }}
        placeholder={
          placeholder ??
          'Message the orchestrator (Enter to send, Shift+Enter for newline, ↑/↓ for history)'
        }
        disabled={disabled}
        className="resize-none overflow-y-auto border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
        style={{ minHeight: COMPOSER_MIN_PX, maxHeight: COMPOSER_MAX_PX }}
      />
      {queuedPrompts.length > 0 && (
        <div className="flex flex-col gap-1 border border-dashed border-border bg-muted/30 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Queued · {queuedPrompts.length}
          </div>
          {queuedPrompts.map((q, i) => (
            <div
              key={i}
              className="flex items-start gap-2 text-xs text-muted-foreground"
              title="Will be sent when the current turn ends"
            >
              <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider">
                #{i + 1}
              </span>
              <span className="truncate italic" title={q}>{q}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
        <button
          type="button"
          onClick={clickInterrupt}
          disabled={disabled || interruptFeedback === 'sent'}
          title="Stop the current response (sends Escape to the PTY)"
          className={
            'px-3 py-1 text-xs font-medium uppercase tracking-wider disabled:opacity-100 ' +
            (interruptFeedback === 'sent'
              ? 'bg-success text-background'
              : interruptFeedback === 'failed'
                ? 'bg-warning text-background'
                : 'bg-destructive text-destructive-foreground hover:bg-destructive/90')
          }
        >
          {interruptFeedback === 'sent'
            ? '✓ Sent'
            : interruptFeedback === 'failed'
              ? 'Failed — not connected'
              : 'Interrupt'}
        </button>
      </div>
    </div>
  );
}
