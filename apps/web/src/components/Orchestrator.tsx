// Vendored from emersonmccuin-pixel/pc-pty-chat-rig @ legacy/app.js (MIT)
// Source: apps/web/legacy/app.js (lines 1–550)
// Adapted for Project Companion: React + WS-shaped per-project event stream
// (not v1's API-message polling), react-markdown for assistant text, bundled
// `<channel>` block split into one bubble per block (Session M Followup), and
// stacked Ask card with Cancel (Session M point 3).

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { Project } from '@/api/client';
import type {
  ApprovalRequiredEvent,
  AssistantEvent,
  ChatEvent,
  TaskEndEvent,
  TaskStartEvent,
  TodosEvent,
  ToolStartEvent,
  UserEvent,
  WsEnvelope,
  WsOutbound,
} from '@/hooks/use-project-ws';

interface OrchestratorProps {
  project: Project;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
}

// Suppress tool-line rendering for tools that surface through dedicated
// bubbles (Task = task-start/task-end card; TodoWrite = todos card) or that
// are pure noise in the chat panel.
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
  // Pull chat-event envelopes + ask envelopes out of the WS stream.
  const chatEnvelopes = useMemo(
    () => events.filter((e) => e.type === 'event' || e.type === 'ask'),
    [events],
  );

  // Track approvals resolved client-side so we can hide their cards
  // optimistically (the runtime emits no resolution event today).
  const [resolvedApprovals, setResolvedApprovals] = useState<
    Record<string, { approved: boolean; response: string }>
  >({});

  // Track ask cards already answered by THIS client (the hook is one-shot per
  // toolUseId; server forgets the pending entry after reply). Don't render
  // dismissed cards on replay either.
  const [answeredAsks, setAnsweredAsks] = useState<Record<string, string>>({});

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatEnvelopes.length]);

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
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {chatEnvelopes.map((env, idx) => {
            const key = `${env.type}-${idx}-${(env as { event?: { ts?: string } }).event?.ts ?? ''}`;
            if (env.type === 'ask') {
              const askEnv = env as WsEnvelope & {
                toolName: string;
                toolUseId: string;
                toolInput: unknown;
              };
              const answered = answeredAsks[askEnv.toolUseId];
              return (
                <AskCard
                  key={key}
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
                key={key}
                event={ev}
                projectId={project.id}
                resolvedApprovals={resolvedApprovals}
                onApprovalResolved={markApprovalResolved}
              />
            );
          })}
          {chatEnvelopes.length === 0 && (
            <div className="text-center text-xs text-muted-foreground">
              No chat events yet. Send a message below to wake the orchestrator.
            </div>
          )}
        </div>
      </div>
      <Composer
        onSend={(text) => send({ type: 'send', text })}
        onInterrupt={() => send({ type: 'interrupt' })}
      />
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
    case 'tool-start': {
      const t = event as ToolStartEvent;
      if (SUPPRESSED_TOOLS.has(t.tool)) return null;
      return <ToolLine tool={t.tool} />;
    }
    case 'tool-end':
      return null; // legacy parity: quiet
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

// ── User bubble (with channel-block split) ───────────────────────────────

function UserBubble({ event }: { event: UserEvent }) {
  const parts = useMemo(() => parseUserText(event.text ?? ''), [event.text]);
  return (
    <>
      {parts.map((part, idx) =>
        part.kind === 'channel' ? (
          <div
            key={idx}
            className="self-start max-w-[85%] border border-warning/60 bg-warning/5 px-3 py-2 text-sm"
          >
            <div className="mb-1 text-[10px] uppercase tracking-wider text-warning">
              channel · {part.source}
            </div>
            <div className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {part.text || '(empty body)'}
            </div>
          </div>
        ) : (
          <div
            key={idx}
            className="self-end max-w-[85%] border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-foreground"
          >
            <div className="whitespace-pre-wrap break-words">
              {part.text || '(empty prompt)'}
            </div>
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
        {event.transcriptPath
          ? `(no assistant text — transcript empty or missing at ${event.transcriptPath})`
          : '(no transcript path provided by Stop hook)'}
      </div>
    );
  }
  return (
    <div className="self-start max-w-[85%] border border-border bg-card px-3 py-2 text-sm text-foreground">
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

// ── Tool line ────────────────────────────────────────────────────────────

function ToolLine({ tool }: { tool: string }) {
  return (
    <div className="self-start text-xs text-muted-foreground">
      → <span className="text-foreground">{tool}</span>
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
    <div className="self-start max-w-[85%] border-l-2 border-success bg-card px-3 py-2 text-sm">
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
  const question = input.questions?.[0];
  const extraQuestions = (input.questions?.length ?? 0) - 1;

  function reply(answer: string) {
    if (answered) return;
    onReply(answer);
  }

  return (
    <div className="self-start max-w-[85%] border border-accent/60 bg-card px-3 py-2 text-sm">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-accent">
        {isPlan ? 'Plan ready — review:' : 'Claude is asking:'}
      </div>
      {isPlan ? (
        <pre className="mb-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border border-border bg-background p-2 font-mono text-xs">
          {input.plan ?? '(no plan text)'}
        </pre>
      ) : question ? (
        <div className="mb-2 text-sm text-foreground">{question.question || '(blank question)'}</div>
      ) : (
        <div className="mb-2 text-sm italic text-muted-foreground">
          (no questions in payload — sending empty answer)
        </div>
      )}

      <div className="flex flex-col gap-2">
        {isPlan
          ? ['approve', 'reject'].map((value) => (
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
            ))
          : (question?.options ?? []).map((opt) => (
              <div key={opt.label} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  disabled={!!answered}
                  onClick={() => reply(opt.label)}
                  className={
                    'self-start border border-border bg-background px-3 py-1 text-xs uppercase tracking-wider hover:bg-muted hover:text-foreground disabled:opacity-50 ' +
                    (answered === opt.label ? 'border-primary text-primary' : 'text-foreground')
                  }
                >
                  {opt.label}
                </button>
                {opt.description && (
                  <div className="ml-1 text-xs text-muted-foreground">{opt.description}</div>
                )}
              </div>
            ))}
        {extraQuestions > 0 && (
          <div className="text-xs italic text-muted-foreground">
            (+{extraQuestions} more question{extraQuestions === 1 ? '' : 's'} in this call — only
            the first is handled)
          </div>
        )}
      </div>

      <div className="mt-2 border-t border-border pt-2">
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
          Answered: <span className="text-foreground">{answered}</span>
        </div>
      )}
    </div>
  );
}

// ── Composer (send + interrupt) ──────────────────────────────────────────

function Composer({
  onSend,
  onInterrupt,
}: {
  onSend: (text: string) => boolean;
  onInterrupt: () => boolean;
}) {
  const [text, setText] = useState('');

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (onSend(trimmed)) setText('');
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-card px-4 py-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder="Message the orchestrator (Enter to send, Shift+Enter for newline)"
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
