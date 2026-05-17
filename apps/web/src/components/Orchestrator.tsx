// Vendored from emersonmccuin-pixel/pc-pty-chat-rig @ legacy/app.js (MIT)
// Source: apps/web/legacy/app.js (lines 1–550)
// Adapted for Project Companion: React + WS-shaped per-project event stream
// (not v1's API-message polling), react-markdown for assistant text, bundled
// `<channel>` block split into one bubble per block (Session M Followup), and
// stacked Ask card with Cancel (Session M point 3).

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { api, type OrchestratorSession, type Project } from '@/api/client';
import type {
  ApprovalRequiredEvent,
  AssistantEvent,
  ChatEvent,
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
  const chatEnvelopes = useMemo(
    () => sourceEvents.filter((e) => e.type === 'event' || e.type === 'ask'),
    [sourceEvents],
  );
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
  // Used to render the thinking indicator + elapsed timer below the chat.
  // turn-end also flips us out of thinking — the channel fires that immediately
  // after Stop, sometimes ahead of the trailing state:'ready' envelope.
  const liveState = useMemo<string | null>(() => {
    if (viewingSessionId) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type === 'turn-end') return 'ready';
      if (env.type === 'state') return (env as WsEnvelope & { state: string }).state;
    }
    return null;
  }, [events, viewingSessionId]);
  const isThinking = liveState === 'thinking';

  // Elapsed-time counter — starts when state flips to thinking, ticks every
  // 200ms while thinking, frozen on Stop. Cheap setInterval; teardown cancels.
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
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
    }
  }, [isThinking, thinkingStartedAt]);
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
          {isThinking && <ThinkingIndicator elapsedMs={elapsedMs} />}
        </div>
      </div>
      {!isViewingPast && (
        <Composer
          projectSlug={project.slug}
          onSend={(text) => send({ type: 'send', text })}
          onInterrupt={() => send({ type: 'interrupt' })}
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
    default:
      return null;
  }
}

// ── Thinking indicator (with elapsed-time counter) ───────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}

function ThinkingIndicator({ elapsedMs }: { elapsedMs: number }) {
  return (
    <div className="self-start flex items-center gap-2 border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      <span className="thinking-dots inline-flex items-center gap-0.5">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </span>
      <span>Thinking</span>
      <span className="font-mono tabular-nums text-foreground/70">
        {formatElapsed(elapsedMs)}
      </span>
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

// ── Role label chip (top of each user / assistant bubble) ────────────────

function RoleLabel({ role }: { role: 'user' | 'claude' }) {
  const text = role === 'user' ? 'You' : 'Claude';
  const tone =
    role === 'user'
      ? 'text-primary'
      : 'text-muted-foreground';
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
            className="group relative self-end max-w-[85%] border border-primary/50 bg-primary/15 px-3 py-2 text-sm text-foreground"
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
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
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

function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(() => AUTO_EXPAND_TOOLS.has(call.tool));
  const summary = summarizeInput(call.tool, call.input);
  return (
    <div className="border-l border-border pl-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
  forceOpen,
}: {
  tool: string;
  calls: ToolCall[];
  forceOpen: boolean | null;
}) {
  const [open, setOpen] = useState(true);
  const effectiveOpen = forceOpen === null ? open : forceOpen;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-baseline gap-1.5 text-left text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <span className="font-mono text-[10px]">{effectiveOpen ? '▼' : '▶'}</span>
        <span>{tool}</span>
        <span className="text-muted-foreground/70">({calls.length})</span>
      </button>
      {effectiveOpen && (
        <div className="flex flex-col gap-1 pl-3">
          {calls.map((c, i) => (
            <ToolCallRow key={`${c.toolUseId ?? c.startedAt}-${i}`} call={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolGroupBubble({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  // null = subgroups + rows manage their own state; true/false = forced from L1
  // expand-all / collapse-all. Cleared whenever the user clicks an individual
  // subgroup / row chevron (handled via key-bump below).
  const [forceState, setForceState] = useState<boolean | null>(null);
  const [bumpKey, setBumpKey] = useState(0);

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

  function expandAll() {
    setForceState(true);
    setBumpKey((k) => k + 1);
    setOpen(true);
  }
  function collapseAll() {
    setForceState(false);
    setBumpKey((k) => k + 1);
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
          <div className="flex gap-1 text-[10px] uppercase tracking-wider">
            <button
              type="button"
              onClick={expandAll}
              className="border border-border bg-background px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
              title="Expand all calls"
            >
              expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="border border-border bg-background px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
              title="Collapse all calls"
            >
              collapse all
            </button>
          </div>
        )}
      </div>
      {open && (
        <div key={bumpKey} className="mt-2 flex flex-col gap-2">
          {byTool.map(([tool, list]) => (
            <ToolSubgroup key={tool} tool={tool} calls={list} forceOpen={forceState} />
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
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
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Q{qIdx + 1}
                  {q.header ? ` · ${q.header}` : ''}
                </div>
                <div className="text-sm text-foreground">
                  {q.question || '(blank question)'}
                </div>
                <div className="flex flex-col gap-2">
                  {(q.options ?? []).map((opt) => (
                    <div key={opt.label} className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        disabled={!!answered}
                        onClick={() =>
                          setPicks((prev) => ({ ...prev, [qIdx]: opt.label }))
                        }
                        className={
                          'self-start border border-border bg-background px-3 py-1 text-xs uppercase tracking-wider hover:bg-muted hover:text-foreground disabled:opacity-50 ' +
                          (picked === opt.label
                            ? 'border-primary text-primary'
                            : 'text-foreground')
                        }
                      >
                        {opt.label}
                      </button>
                      {opt.description && (
                        <div className="ml-1 text-xs text-muted-foreground">
                          {opt.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        // Single question — fast-path click-to-submit.
        <>
          <div className="mb-2 text-sm text-foreground">
            {questions[0]!.question || '(blank question)'}
          </div>
          <div className="flex flex-col gap-2">
            {(questions[0]!.options ?? []).map((opt) => (
              <div key={opt.label} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  disabled={!!answered}
                  onClick={() => reply(opt.label)}
                  className={
                    'self-start border border-border bg-background px-3 py-1 text-xs uppercase tracking-wider hover:bg-muted hover:text-foreground disabled:opacity-50 ' +
                    (answered === opt.label
                      ? 'border-primary text-primary'
                      : 'text-foreground')
                  }
                >
                  {opt.label}
                </button>
                {opt.description && (
                  <div className="ml-1 text-xs text-muted-foreground">{opt.description}</div>
                )}
              </div>
            ))}
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
            Submit
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
}: {
  projectSlug: string;
  onSend: (text: string) => boolean;
  onInterrupt: () => boolean;
}) {
  const [text, setText] = useState('');
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
          onClick={() => onInterrupt()}
          title="Send Ctrl+C to the PTY"
          className="bg-destructive px-3 py-1 text-xs font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90"
        >
          Interrupt
        </button>
      </div>
    </div>
  );
}
