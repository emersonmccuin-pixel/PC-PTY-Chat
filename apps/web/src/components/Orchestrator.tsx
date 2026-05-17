// Vendored from emersonmccuin-pixel/pc-pty-chat-rig @ legacy/app.js (MIT)
// Source: apps/web/legacy/app.js (lines 1–550)
// Adapted for Project Companion: React + WS-shaped per-project event stream
// (not v1's API-message polling), react-markdown for assistant text, bundled
// `<channel>` block split into one bubble per block (Session M Followup), and
// stacked Ask card with Cancel (Session M point 3).

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { api, type OrchestratorSession, type Project } from '@/api/client';
import type {
  ApprovalRequiredEvent,
  AssistantEvent,
  ChatEvent,
  JsonlEvent,
  NotificationEvent,
  TaskEndEvent,
  TaskStartEvent,
  TodosEvent,
  ToolEndEvent,
  ToolStartEvent,
  UserEvent,
  WsEnvelope,
  WsOutbound,
} from '@/hooks/use-project-ws';
import { useViewingSession } from '@/store/viewing-session';

interface OrchestratorProps {
  project: Project;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
}

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

// Tools whose call detail (input + result) is high-stakes enough to auto-expand
// in L3 — the user shouldn't have to click to see what changed on disk.
const AUTO_EXPAND_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// ── Tool-call grouping ───────────────────────────────────────────────────
// Per chat.md: each turn's tool calls collapse into a single "Tool calls"
// group (L1), broken down by tool type (L2), with individual call details
// (L3) underneath. We synthesize this by walking chat envelopes in order
// and bucketing consecutive tool-start/tool-end pairs.

interface ToolCall {
  toolUseId: string | null;
  tool: string;
  input: unknown;
  result: unknown;
  startedAt: string;
  ended: boolean;
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

type RenderItem = ToolGroupItem | EnvItem;

// ── JSONL→hook normalization + cross-channel dedupe (Section 0) ──────────
// Until Section 0 phase 0f strips the legacy hook path, BOTH `type:'event'`
// (hook-driven) AND `type:'jsonl'` (canonical) envelopes flow through. The
// jsonl path is preferred for turn lifecycle + tool calls; we drop the hook
// envelope when a logically-matching jsonl envelope exists in the stream.

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
      // Tool name is not on the result line in CC's JSONL; downstream tool-
      // group matching uses toolUseId so a placeholder name is fine.
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
    case 'jsonl-queue-enqueue':
    case 'jsonl-queue-dequeue':
    case 'jsonl-sidechain':
      return null;
    default:
      return null;
  }
}

/** Walk the envelope stream and mark hook envelopes that have a matching
 *  jsonl counterpart for suppression. Greedy left-to-right pairing: each
 *  jsonl event claims the earliest unclaimed hook envelope of matching
 *  identity (text for user/assistant; toolUseId for tools). Tool-start AND
 *  tool-end hook envelopes for a given toolUseId are both suppressed when
 *  any jsonl-tool-call/result with that id is present. */
function buildSuppressedHookIndices(envelopes: WsEnvelope[]): Set<number> {
  const suppressed = new Set<number>();
  const hookUsers: Array<{ idx: number; text: string; claimed: boolean }> = [];
  const hookAssistants: Array<{ idx: number; text: string; claimed: boolean }> = [];
  const hookToolsByUseId = new Map<string, number[]>();
  const jsonlEvents: JsonlEvent[] = [];

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.type === 'event') {
      const ev = (env as WsEnvelope & { event: ChatEvent }).event;
      if (!ev || typeof ev !== 'object') continue;
      if (ev.kind === 'user') {
        hookUsers.push({ idx: i, text: (ev as UserEvent).text ?? '', claimed: false });
      } else if (ev.kind === 'assistant') {
        hookAssistants.push({
          idx: i,
          text: (ev as AssistantEvent).text ?? '',
          claimed: false,
        });
      } else if (ev.kind === 'tool-start' || ev.kind === 'tool-end') {
        const t = ev as ToolStartEvent | ToolEndEvent;
        if (t.toolUseId) {
          const arr = hookToolsByUseId.get(t.toolUseId) ?? [];
          arr.push(i);
          hookToolsByUseId.set(t.toolUseId, arr);
        }
      }
    } else if (env.type === 'jsonl') {
      const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
      if (ev && typeof ev === 'object') jsonlEvents.push(ev);
    }
  }

  for (const ev of jsonlEvents) {
    if (ev.kind === 'jsonl-user') {
      for (const h of hookUsers) {
        if (!h.claimed && h.text === ev.text) {
          h.claimed = true;
          suppressed.add(h.idx);
          break;
        }
      }
    } else if (ev.kind === 'jsonl-turn-end') {
      for (const h of hookAssistants) {
        if (!h.claimed && h.text === ev.text) {
          h.claimed = true;
          suppressed.add(h.idx);
          break;
        }
      }
    } else if (ev.kind === 'jsonl-tool-call' || ev.kind === 'jsonl-tool-result') {
      const id = ev.toolUseId;
      if (id) {
        const indices = hookToolsByUseId.get(id);
        if (indices) for (const i of indices) suppressed.add(i);
      }
    }
  }

  return suppressed;
}

function synthesizeRenderItems(envelopes: WsEnvelope[]): RenderItem[] {
  const items: RenderItem[] = [];
  let buffer: ToolCall[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      items.push({ kind: 'tool-group', key: `tg-${buffer[0]!.startedAt}`, calls: buffer });
      buffer = [];
    }
  };

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.type === 'ask') {
      flush();
      items.push({ kind: 'env', key: `env-${i}`, env });
      continue;
    }
    if (env.type !== 'event') {
      flush();
      items.push({ kind: 'env', key: `env-${i}`, env });
      continue;
    }
    const ev = (env as WsEnvelope & { event: ChatEvent }).event;
    if (!ev || typeof ev !== 'object' || !('kind' in ev)) {
      flush();
      items.push({ kind: 'env', key: `env-${i}`, env });
      continue;
    }
    // Suppressed tool events (Task, Agent, TodoWrite, etc) — let their
    // dedicated bubbles render via the normal envelope path.
    if ((ev.kind === 'tool-start' || ev.kind === 'tool-end') &&
        SUPPRESSED_TOOLS.has((ev as ToolStartEvent | ToolEndEvent).tool)) {
      continue;
    }
    if (ev.kind === 'tool-start') {
      const t = ev as ToolStartEvent;
      buffer.push({
        toolUseId: t.toolUseId ?? null,
        tool: t.tool,
        input: t.input ?? null,
        result: null,
        startedAt: t.ts ?? `${i}`,
        ended: false,
      });
      continue;
    }
    if (ev.kind === 'tool-end') {
      const t = ev as ToolEndEvent;
      // Find matching call in the current buffer first (tool_use_id match
      // takes priority; fall back to last unmatched of same tool name).
      let matched: ToolCall | null = null;
      if (t.toolUseId) {
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
      // Last resort: walk back through prior tool-groups (handles tool-end
      // that arrived after a non-tool event flushed the buffer).
      if (!matched) {
        for (let j = items.length - 1; j >= 0; j--) {
          const it = items[j]!;
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
        // Orphan tool-end (PreToolUse hook fired but we missed the start) —
        // synthesize a placeholder so we don't drop the result.
        buffer.push({
          toolUseId: t.toolUseId ?? null,
          tool: t.tool,
          input: null,
          result: t.result ?? null,
          startedAt: t.ts ?? `${i}`,
          ended: true,
        });
      }
      continue;
    }
    flush();
    items.push({ kind: 'env', key: `env-${i}-${ev.ts ?? ''}`, env });
  }
  flush();
  return items;
}

// ── Channel-block parser (Session M Followup) ─────────────────────────────
// A user-message turn can bundle multiple `<channel source="...">BODY</channel>`
// blocks when external events arrive in close succession. Render one bubble
// per block instead of one bubble per turn.

interface UserPart {
  kind: 'text' | 'channel';
  text: string;
  source?: string;
}

const CHANNEL_RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;

function parseUserText(text: string): UserPart[] {
  if (!text) return [{ kind: 'text', text: '' }];
  const parts: UserPart[] = [];
  let last = 0;
  for (const m of text.matchAll(CHANNEL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      const slice = text.slice(last, idx).trim();
      if (slice) parts.push({ kind: 'text', text: slice });
    }
    const attrs = m[1] ?? '';
    const body = (m[2] ?? '').trim();
    const sourceMatch = attrs.match(/source\s*=\s*"([^"]+)"/);
    parts.push({ kind: 'channel', text: body, source: sourceMatch?.[1] ?? 'channel' });
    last = idx + m[0].length;
  }
  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) parts.push({ kind: 'text', text: tail });
  }
  if (parts.length === 0) parts.push({ kind: 'text', text });
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

// ── Main component ───────────────────────────────────────────────────────

export function Orchestrator({ project, events, send }: OrchestratorProps) {
  // Viewing a past session? When set, the chat panel renders that session's
  // events.jsonl in read-only mode (composer hidden, "Return to live" button).
  const viewingSessionId = useViewingSession((s) => s.bySlug[project.slug] ?? null);
  const setViewing = useViewingSession((s) => s.setViewing);

  // Fetched events for the viewing-past-session case. Lives in component
  // state, refetched when viewingSessionId changes.
  const [pastEvents, setPastEvents] = useState<WsEnvelope[]>([]);
  const [pastLoading, setPastLoading] = useState(false);
  const [pastError, setPastError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewingSessionId) {
      setPastEvents([]);
      setPastError(null);
      return;
    }
    let cancelled = false;
    setPastLoading(true);
    setPastError(null);
    api
      .getSessionEvents(project.id, viewingSessionId)
      .then((raw) => {
        if (cancelled) return;
        // Wrap each raw chat event into the same { type:'event', event } shape
        // the live stream uses so the renderer below doesn't branch.
        const wrapped: WsEnvelope[] = raw.map((event) => ({
          projectId: project.id,
          type: 'event',
          event: event as Record<string, unknown>,
        }));
        setPastEvents(wrapped);
      })
      .catch((err: Error) => {
        if (!cancelled) setPastError(err.message);
      })
      .finally(() => {
        if (!cancelled) setPastLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewingSessionId, project.id]);

  // Pull chat-event envelopes + ask envelopes out of the WS stream OR the
  // past-session events depending on mode.
  const sourceEvents = viewingSessionId ? pastEvents : events;
  // Section 0 phase 0c: dedupe hook-driven events against their jsonl-tailer
  // counterparts (preferring jsonl) and normalize jsonl envelopes into the
  // hook shape the synthesizer + bubble components already understand.
  const chatEnvelopes = useMemo(() => {
    const suppressed = buildSuppressedHookIndices(sourceEvents);
    const out: WsEnvelope[] = [];
    for (let i = 0; i < sourceEvents.length; i++) {
      if (suppressed.has(i)) continue;
      const env = sourceEvents[i]!;
      if (env.type === 'ask' || env.type === 'event') {
        out.push(env);
        continue;
      }
      if (env.type === 'jsonl') {
        const normalized = normalizeJsonlEnvelope(env);
        if (normalized) out.push(normalized);
      }
    }
    return out;
  }, [sourceEvents]);
  // Collapse the flat envelope list into render-ready items: most envelopes
  // pass through as-is, but consecutive tool-start/tool-end events fold into
  // a single ToolGroup bucket for the L1/L2/L3 hierarchy.
  const renderItems = useMemo(() => synthesizeRenderItems(chatEnvelopes), [chatEnvelopes]);

  // Track approvals resolved client-side so we can hide their cards
  // optimistically (the runtime emits no resolution event today).
  const [resolvedApprovals, setResolvedApprovals] = useState<
    Record<string, { approved: boolean; response: string }>
  >({});

  // Track ask cards already answered by THIS client (the hook is one-shot per
  // toolUseId; server forgets the pending entry after reply). Don't render
  // dismissed cards on replay either.
  const [answeredAsks, setAnsweredAsks] = useState<Record<string, string>>({});

  // Active session. Fetched once per project, then patched live from WS
  // session-changed events (server emits these on title set + new-session).
  const [session, setSession] = useState<OrchestratorSession | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getActiveSession(project.id)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((err) => console.error('[pc] getActiveSession', err));
    return () => {
      cancelled = true;
    };
  }, [project.id]);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'session-changed') {
        setSession((e as WsEnvelope & { session: OrchestratorSession }).session);
        break;
      }
    }
  }, [events]);

  // Latest PTY state from the WS stream (`{type:'state', state:'thinking'|'ready'|...}`).
  // Legacy hook-driven derivation — kept as fallback when no jsonl events are
  // present (replay of historical sessions, or CC versions where the JSONL
  // shape doesn't match what we parse).
  const liveState = useMemo<string | null>(() => {
    if (viewingSessionId) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type === 'turn-end') return 'ready';
      if (env.type === 'state') return (env as WsEnvelope & { state: string }).state;
      // Phase 0c-followup case 1: API errors fire `StopFailure` (not `Stop`).
      // No assistant content lands in JSONL on rate-limit / prompt-too-long /
      // auth failure, so the JSONL emit can't clear isThinking. Treat the
      // hook-emitted `stop-failure` event as a defensive turn-end.
      if (env.type === 'event') {
        const ev = (env as WsEnvelope & { event: ChatEvent }).event;
        if (ev?.kind === 'stop-failure') return 'ready';
      }
    }
    return null;
  }, [events, viewingSessionId]);

  // Section 0 phase 0c — jsonl-busy: true between jsonl-user and the matching
  // jsonl-turn-end. Authoritative for the thinking indicator when any jsonl
  // event is present; falls back to legacy hook state otherwise. Defensive:
  // if jsonl claims busy but the legacy hook says 'ready' (Stop fired), trust
  // the legacy state — protects against a stuck indicator if jsonl-turn-end
  // never lands for some reason.
  const jsonlBusy = useMemo<boolean | null>(() => {
    if (viewingSessionId) return null;
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
  }, [events, viewingSessionId]);

  const isThinking =
    jsonlBusy === null
      ? liveState === 'thinking'
      : jsonlBusy && liveState !== 'ready';

  // Section 0 phase 0d — queued-prompt UI. CC's JSONL queue-operation lines
  // don't carry the prompt text (verified empirically against real sessions),
  // so we cache locally what the user typed while busy and pop entries when
  // matching dequeue events arrive. Push happens in the onSend closure below.
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
  // Reset queue cache on session change — fresh PC session ⇒ no inheritable
  // queue state. Project switch unmounts the component so no extra cleanup
  // needed there.
  useEffect(() => {
    setQueuedPrompts([]);
    prevDequeueRef.current = 0;
  }, [session?.id]);

  // Section 0 phase 0e — session-end event from CC's SessionEnd hook. The
  // PTY is gone; disable the composer + surface a footer notice. Cleared on
  // new-session (the session?.id useEffect above doesn't fire because the
  // session id changes after a fresh spawn, but checking events.length below
  // re-derives this correctly).
  const sessionEnded = useMemo(() => {
    if (viewingSessionId) return false;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type !== 'event') continue;
      const ev = (env as WsEnvelope & { event: ChatEvent }).event;
      if (ev?.kind === 'session-end') return true;
      // A more recent user prompt OR turn-end means a fresh session is active.
      if (ev?.kind === 'user' || ev?.kind === 'assistant') return false;
    }
    return false;
  }, [events, viewingSessionId]);

  // Elapsed-time counter — starts when state flips to thinking, ticks every
  // 200ms while thinking, frozen on Stop. Cheap setInterval; teardown cancels.
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // When the user clicks Interrupt while thinking, swap the indicator label
  // to "Interrupting…" until the turn actually ends (state flips off thinking).
  // Claude takes a beat to honor Ctrl+C — don't let the user think nothing happened.
  const [interruptedAt, setInterruptedAt] = useState<number | null>(null);
  useEffect(() => {
    if (isThinking) {
      if (thinkingStartedAt === null) {
        const now = Date.now();
        setThinkingStartedAt(now);
        setElapsedMs(0);
      }
    } else if (thinkingStartedAt !== null) {
      setThinkingStartedAt(null);
      setElapsedMs(0);
      setInterruptedAt(null);
    }
  }, [isThinking, thinkingStartedAt]);
  function handleInterrupt(): boolean {
    const ok = send({ type: 'interrupt' });
    if (ok && isThinking) setInterruptedAt(Date.now());
    return ok;
  }
  useEffect(() => {
    if (thinkingStartedAt === null) return;
    const tick = () => setElapsedMs(Date.now() - thinkingStartedAt);
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [thinkingStartedAt]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatEnvelopes.length, isThinking]);

  async function onNewSession() {
    if (!confirm('Start a new chat session? Current chat history will be cleared.')) return;
    try {
      await api.startNewSession(project.id);
    } catch (err) {
      alert(`Couldn't start a new session: ${(err as Error).message}`);
    }
  }

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

  const isViewingPast = viewingSessionId !== null;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
        <div className="min-w-0 flex-1 truncate text-sm">
          {isViewingPast ? (
            <span className="text-muted-foreground">
              Viewing past session <span className="text-foreground/80">(read-only)</span>
            </span>
          ) : session?.title ? (
            <span className="text-foreground" title={session.title}>{session.title}</span>
          ) : (
            <span className="italic text-muted-foreground">Untitled session</span>
          )}
        </div>
        {isViewingPast ? (
          <button
            onClick={() => setViewing(project.slug, null)}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Stop viewing this past session and return to the live chat"
          >
            ← Return to live
          </button>
        ) : (
          <button
            onClick={onNewSession}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            title="End the current chat session and start a fresh one"
          >
            + New session
          </button>
        )}
      </div>
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {renderItems.map((item) => {
            if (item.kind === 'tool-group') {
              return <ToolGroupBubble key={item.key} calls={item.calls} />;
            }
            const env = item.env;
            if (env.type === 'ask') {
              const askEnv = env as WsEnvelope & {
                toolName: string;
                toolUseId: string;
                toolInput: unknown;
              };
              const answered = answeredAsks[askEnv.toolUseId];
              return (
                <AskCard
                  key={item.key}
                  toolName={askEnv.toolName}
                  toolUseId={askEnv.toolUseId}
                  toolInput={askEnv.toolInput}
                  answered={answered}
                  onReply={(answer) => {
                    if (send({ type: 'ask-reply', toolUseId: askEnv.toolUseId, answer })) {
                      setAnsweredAsks((prev) => ({ ...prev, [askEnv.toolUseId]: answer }));
                    }
                  }}
                />
              );
            }
            const ev = (env as WsEnvelope & { event: ChatEvent }).event;
            if (!ev || typeof ev !== 'object') return null;
            return (
              <EventBubble
                key={item.key}
                event={ev}
                projectId={project.id}
                resolvedApprovals={resolvedApprovals}
                onApprovalResolved={markApprovalResolved}
              />
            );
          })}
          {chatEnvelopes.length === 0 && !pastLoading && !pastError && (
            <div className="text-center text-xs text-muted-foreground">
              {isViewingPast
                ? 'This session has no events on disk.'
                : 'No chat events yet. Send a message below to wake the orchestrator.'}
            </div>
          )}
          {pastLoading && (
            <div className="text-center text-xs text-muted-foreground">Loading session…</div>
          )}
          {pastError && (
            <div className="text-center text-xs text-red-400">Error loading session: {pastError}</div>
          )}
          {isThinking && (
            <ThinkingIndicator elapsedMs={elapsedMs} interruptedAt={interruptedAt} />
          )}
        </div>
      </div>
      {!isViewingPast && sessionEnded && (
        <div className="border-t border-border bg-warning/10 px-4 py-2 text-center text-xs text-warning">
          This session ended. Click <span className="font-semibold">+ New session</span> above to start a fresh chat.
        </div>
      )}
      {!isViewingPast && !sessionEnded && (
        <Composer
          projectSlug={project.slug}
          onSend={(text) => {
            const ok = send({ type: 'send', text });
            if (ok && isThinking) {
              setQueuedPrompts((prev) => [...prev, text]);
            }
            return ok;
          }}
          onInterrupt={handleInterrupt}
          queuedPrompts={queuedPrompts}
        />
      )}
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
}

function EventBubble({
  event,
  projectId,
  resolvedApprovals,
  onApprovalResolved,
}: EventBubbleProps) {
  switch (event.kind) {
    case 'user':
      return <UserBubble event={event as UserEvent} />;
    case 'assistant':
      return <AssistantBubble event={event as AssistantEvent} />;
    // tool-start / tool-end never reach here — synthesizeRenderItems
    // folds them into a ToolGroup. Suppressed tools (Task/TodoWrite/etc)
    // route to their dedicated bubbles below.
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
    case 'notification':
      return <NotificationBubble event={event as NotificationEvent} />;
    // session-end renders as a footer notice on the chat panel (not inline);
    // subagent-stop is captured but not rendered in chat (Section 2 owns it).
    case 'session-end':
    case 'subagent-stop':
      return null;
    default:
      return null;
  }
}

function NotificationBubble({ event }: { event: NotificationEvent }) {
  return (
    <div className="self-center max-w-[85%] border border-border bg-muted/30 px-3 py-1.5 text-center text-xs text-muted-foreground">
      <div className="text-[10px] uppercase tracking-wider">
        {event.title ?? 'Notification'}
      </div>
      <div className="mt-0.5 italic">{event.message || '(no message)'}</div>
    </div>
  );
}

// ── Thinking indicator (with elapsed-time counter) ───────────────────────

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
  // While interrupting, tick our OWN clock against interruptedAt so the
  // user sees the wait until Claude actually stops responding. Show a hint
  // after 5s in case Claude is wedged.
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

// ── Copy-to-clipboard button (hover-reveal on bubble) ─────────────────────

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

// ── Role label (small text header on top of each user / assistant bubble) ─

function RoleLabel({ role }: { role: 'user' | 'claude' }) {
  const text = role === 'user' ? 'You' : 'Claude';
  const tone = role === 'user' ? 'text-primary/80' : 'text-muted-foreground';
  return (
    <div className={`mb-1 text-[10px] uppercase tracking-wider ${tone}`}>{text}</div>
  );
}

// ── User bubble (with channel-block split) ───────────────────────────────

function UserBubble({ event }: { event: UserEvent }) {
  const parts = useMemo(() => parseUserText(event.text ?? ''), [event.text]);
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
          <div
            key={idx}
            className="group relative self-end max-w-[85%] border border-primary/60 bg-primary/30 px-3 py-2 text-sm text-foreground"
          >
            <RoleLabel role="user" />
            <div className="whitespace-pre-wrap break-words">
              {part.text || '(empty prompt)'}
            </div>
            <CopyButton text={part.text} />
          </div>
        ),
      )}
    </>
  );
}

// ── Assistant bubble (markdown via react-markdown) ───────────────────────

function AssistantBubble({ event }: { event: AssistantEvent }) {
  const text = event.text ?? '';
  if (!text) {
    return (
      <div className="self-start max-w-[85%] border border-border bg-card px-3 py-2 text-sm italic text-muted-foreground">
        <RoleLabel role="claude" />
        {event.transcriptPath
          ? `(no assistant text — transcript empty or missing at ${event.transcriptPath})`
          : '(no transcript path provided by Stop hook)'}
      </div>
    );
  }
  return (
    <div className="group relative self-start max-w-[85%] border border-border bg-card px-3 py-2 text-sm text-foreground">
      <RoleLabel role="claude" />
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
      </div>
      <CopyButton text={text} />
    </div>
  );
}

// ── Tool-calls group (L1 → L2 → L3 collapsible hierarchy) ────────────────
// L1 is the per-turn "Tool calls" group (collapsed by default).
// L2 is per-tool-type subgroup (expanded by default once L1 opens).
// L3 is the individual call detail (collapsed except for Edit/Write/NotebookEdit).

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
  // Edit gets an old/new split block; Write shows file_path + content preview.
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

// Expand / collapse-all chip pair used at L1 + L2 headers. Stops the parent
// button's click-bubble so toggling the chip doesn't also toggle the header.
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

function ToolGroupBubble({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  // Per-row + per-subgroup open state lifted up here so L1's expand-all can
  // actually cascade to every level. Missing keys fall back to defaults (rows
  // default closed unless AUTO_EXPAND_TOOLS; subgroups default open).
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
    return k in rowsOpen ? rowsOpen[k]! : AUTO_EXPAND_TOOLS.has(c.tool);
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
    <div className="self-start max-w-[85%] border border-border bg-card px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-baseline gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
          <span className="font-medium uppercase tracking-wider text-foreground">Tool calls</span>
          <span className="text-muted-foreground/70">({total})</span>
          {running > 0 && (
            <span className="text-[10px] italic text-warning">· {running} running</span>
          )}
        </button>
        {open && (
          <ExpandCollapseChips
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
            scope="call"
          />
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
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
        </div>
      )}
    </div>
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
    <div className="self-start max-w-[85%] border border-warning/60 bg-card px-3 py-2 text-sm">
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

// ── Ask card (stacked options + Cancel) ──────────────────────────────────

interface AskCardProps {
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  answered?: string;
  onReply: (answer: string) => void;
}

interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function AskCard({ toolName, toolInput, answered, onReply }: AskCardProps) {
  const input = (toolInput ?? {}) as { plan?: string; questions?: AskQuestion[] };
  const isPlan = toolName === 'ExitPlanMode';
  const questions = input.questions ?? [];
  const isMulti = !isPlan && questions.length > 1;

  // Staged picks for the multi-question path (index → chosen label).
  // Single-question path keeps fire-on-click: no staging buffer needed.
  const [picks, setPicks] = useState<Record<number, string>>({});

  function reply(answer: string) {
    if (answered) return;
    onReply(answer);
  }

  function submitMulti() {
    if (answered) return;
    // Pack as JSON so the orchestrator sees one line per question.
    // Format chosen for readability inside the deny-reason string:
    //   [{"question":"X","answer":"A"}, {"question":"Y","answer":"B"}]
    const payload = questions.map((q, i) => ({
      question: q.question,
      answer: picks[i] ?? '',
    }));
    onReply(JSON.stringify(payload));
  }

  const canSubmitMulti =
    isMulti && questions.every((_, i) => picks[i] !== undefined);

  return (
    <div className="self-start max-w-[85%] border border-accent/60 bg-card px-3 py-2 text-sm">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-accent">
        {isPlan
          ? 'Plan ready — review:'
          : isMulti
            ? `Claude is asking ${questions.length} questions:`
            : 'Claude is asking:'}
      </div>

      {isPlan ? (
        <>
          <pre className="mb-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border border-border bg-background p-2 font-mono text-xs">
            {input.plan ?? '(no plan text)'}
          </pre>
          <div className="flex flex-col gap-2">
            {['approve', 'reject'].map((value) => (
              <button
                key={value}
                type="button"
                disabled={!!answered}
                onClick={() => reply(value)}
                className={
                  'self-start border border-border bg-background px-3 py-1 text-xs uppercase tracking-wider hover:bg-muted hover:text-foreground disabled:opacity-50 ' +
                  (answered === value ? 'border-primary text-primary' : 'text-foreground')
                }
              >
                {value === 'approve' ? 'Approve' : 'Reject'}
              </button>
            ))}
          </div>
        </>
      ) : questions.length === 0 ? (
        <div className="mb-2 text-sm italic text-muted-foreground">
          (no questions in payload — sending empty answer)
        </div>
      ) : isMulti ? (
        <div className="flex flex-col gap-4">
          {questions.map((q, qIdx) => {
            const picked = picks[qIdx];
            return (
              <div key={qIdx} className="flex flex-col gap-2 border-l border-border pl-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">
                    Q{qIdx + 1}
                    {q.header ? ` · ${q.header}` : ''}
                  </span>
                  {picked ? (
                    <span className="bg-success px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-background">
                      picked
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider text-warning">
                      pick one
                    </span>
                  )}
                </div>
                <div className="text-sm text-foreground">
                  {q.question || '(blank question)'}
                </div>
                <div className="flex flex-col gap-2">
                  {(q.options ?? []).map((opt) => {
                    const selected = picked === opt.label;
                    return (
                      <div key={opt.label} className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          disabled={!!answered}
                          onClick={() =>
                            setPicks((prev) => ({ ...prev, [qIdx]: opt.label }))
                          }
                          className={
                            'self-start border px-3 py-1 text-xs uppercase tracking-wider disabled:opacity-50 ' +
                            (selected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-background text-foreground hover:bg-muted hover:text-foreground')
                          }
                        >
                          {selected ? '✓ ' : ''}
                          {opt.label}
                        </button>
                        {opt.description && (
                          <div className="ml-1 text-xs text-muted-foreground">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Picks-so-far summary so the user sees exactly what's about to be submitted. */}
          <div className="border border-border bg-background/50 px-2 py-1.5">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              your answers
            </div>
            <ul className="flex flex-col gap-0.5 text-xs">
              {questions.map((_q, qIdx) => {
                const picked = picks[qIdx];
                return (
                  <li key={qIdx} className="flex items-baseline gap-1.5">
                    <span className="text-muted-foreground">Q{qIdx + 1}:</span>
                    {picked ? (
                      <span className="text-foreground">{picked}</span>
                    ) : (
                      <span className="italic text-warning/80">(not picked yet)</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : (
        // Single question — fast-path click-to-submit.
        <>
          <div className="mb-2 text-sm text-foreground">
            {questions[0]!.question || '(blank question)'}
          </div>
          <div className="flex flex-col gap-2">
            {(questions[0]!.options ?? []).map((opt) => {
              const selected = answered === opt.label;
              return (
                <div key={opt.label} className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    disabled={!!answered}
                    onClick={() => reply(opt.label)}
                    className={
                      'self-start border px-3 py-1 text-xs uppercase tracking-wider disabled:opacity-50 ' +
                      (selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-foreground hover:bg-muted hover:text-foreground')
                    }
                  >
                    {selected ? '✓ ' : ''}
                    {opt.label}
                  </button>
                  {opt.description && (
                    <div className="ml-1 text-xs text-muted-foreground">{opt.description}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2">
        {isMulti && (
          <button
            type="button"
            disabled={!!answered || !canSubmitMulti}
            onClick={submitMulti}
            title={canSubmitMulti ? 'Submit all answers' : 'Pick an option for every question first'}
            className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Submit{canSubmitMulti ? ` ${Object.keys(picks).length} answer${Object.keys(picks).length === 1 ? '' : 's'}` : ''}
          </button>
        )}
        <button
          type="button"
          disabled={!!answered}
          onClick={() => reply('__cancelled__')}
          title="Decline to answer — orchestrator gets a deny reason and can proceed differently."
          className={
            'border border-border bg-background px-3 py-1 text-xs uppercase tracking-wider hover:bg-muted hover:text-foreground disabled:opacity-50 ' +
            (answered === '__cancelled__' ? 'border-primary text-primary' : 'text-muted-foreground')
          }
        >
          Cancel
        </button>
      </div>

      {answered && (
        <div className="mt-2 text-xs text-muted-foreground">
          Answered: <span className="break-words text-foreground">{answered}</span>
        </div>
      )}
    </div>
  );
}

// ── Composer (send + interrupt + prompt history) ─────────────────────────

const PROMPT_HISTORY_CAP = 100;

function historyKey(slug: string) {
  return `pc:prompt-history:${slug}`;
}

function readHistory(slug: string): string[] {
  try {
    const raw = localStorage.getItem(historyKey(slug));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function writeHistory(slug: string, list: string[]) {
  try {
    localStorage.setItem(historyKey(slug), JSON.stringify(list));
  } catch {
    /* quota / disabled storage — best effort */
  }
}

function Composer({
  projectSlug,
  onSend,
  onInterrupt,
  queuedPrompts,
}: {
  projectSlug: string;
  onSend: (text: string) => boolean;
  onInterrupt: () => boolean;
  queuedPrompts: string[];
}) {
  const [text, setText] = useState('');
  // 'sent' confirms a Ctrl+C went out (button flashes "Sent ✓" briefly).
  // 'failed' if WS was closed when we tried — at least the user knows.
  const [interruptFeedback, setInterruptFeedback] = useState<'sent' | 'failed' | null>(null);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clickInterrupt() {
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
    const ok = onInterrupt();
    setInterruptFeedback(ok ? 'sent' : 'failed');
    interruptTimerRef.current = setTimeout(() => setInterruptFeedback(null), 1500);
  }
  useEffect(() => () => {
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
  }, []);
  // History buffer + cursor. `historyIdx === null` means "not navigating".
  // When navigating, Up/Down move through entries; sending resets to null.
  const historyRef = useRef<string[]>(readHistory(projectSlug));
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);

  // Reload on project switch.
  useEffect(() => {
    historyRef.current = readHistory(projectSlug);
    setHistoryIdx(null);
    setText('');
  }, [projectSlug]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (onSend(trimmed)) {
      const hist = historyRef.current;
      // De-dup consecutive duplicates, cap at PROMPT_HISTORY_CAP.
      if (hist[hist.length - 1] !== trimmed) {
        hist.push(trimmed);
        if (hist.length > PROMPT_HISTORY_CAP) hist.splice(0, hist.length - PROMPT_HISTORY_CAP);
        writeHistory(projectSlug, hist);
      }
      setHistoryIdx(null);
      setText('');
    }
  }

  function navHistory(direction: -1 | 1) {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (direction === -1) {
      // Up: walk backwards. From "not navigating", jump to last entry.
      const next = historyIdx === null ? hist.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setText(hist[next] ?? '');
    } else {
      // Down: walk forwards. Past the end → exit history nav, clear text.
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
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Typing past a history pick drops us out of nav mode so the
          // next Up doesn't jump backwards from a stale cursor.
          if (historyIdx !== null) setHistoryIdx(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
            return;
          }
          // Up/Down nav history when (a) composer is empty, or (b) we're
          // already mid-history. Otherwise pass through (textarea cursor).
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
        rows={2}
        placeholder="Message the orchestrator (Enter to send, Shift+Enter for newline, ↑/↓ for history)"
        className="resize-none border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none"
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
          disabled={!text.trim()}
          className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
        <button
          type="button"
          onClick={clickInterrupt}
          disabled={interruptFeedback === 'sent'}
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
