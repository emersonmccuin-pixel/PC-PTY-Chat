// Extracted from Orchestrator.tsx — the per-project chat surface that
// renders a live PTY/jsonl event stream as the chat panel the user sees.
// Both <Orchestrator> (live project session) and <AgentDesignerChat>
// (transient agent-designer session) consume this. Wrappers own
// session lifecycle / past-session fetching / status bar; ChatSurface
// owns the actual rendering, composer, thinking indicator, pending-prompt
// state, and cross-tab scroll-to-bubble plumbing.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Copy as CopyIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import type {
  ApprovalRequiredEvent,
  AssistantEvent,
  ChatEvent,
  SubagentFailureEvent,
  SystemEvent,
  TaskEndEvent,
  TaskStartEvent,
  TodosEvent,
  UserEvent,
  WsEnvelope,
  WsStatus,
} from '@/hooks/use-project-ws';
import { useAgentTranscript } from '@/store/agent-transcript';
import { useChatScrollTarget } from '@/store/chat-scroll-target';
import { AskCard } from '@/components/AskCard';
import { TranscriptViewer } from '@/components/TranscriptViewer';
import { parseUserText, type UserPart } from '@/lib/parse-chat-text';
import { LiveRichLink } from '@/components/LiveRichLink';
import { ExternalLink } from '@/components/ExternalLink';
import { Composer } from '@/features/chat/ChatComposer';
import { TerminalModeToggle, TerminalPane } from '@/features/chat/TerminalPane';
import { ApprovalBubble } from '@/features/chat/approvals';
import { injectTodoSnapshots, normalizeJsonlEnvelope } from '@/features/chat/normalizeJsonlEnvelope';
import {
  deriveActivity,
  deriveJsonlBusy,
  deriveLiveState,
  isRuntimeThinking,
  readTerminalMode,
  STALL_WARN_MS,
  summarizeInput,
  writeTerminalMode,
} from '@/features/chat/runtimeState';
import { synthesizeRenderItems } from '@/features/chat/toolGrouping';
import {
  createClientMessageId,
  isPendingUserEvent,
  pendingPromptEnvelope,
  usePendingPrompts,
} from '@/features/chat/usePendingPrompts';
import type {
  AgentEventEntry,
  PendingPromptStatus,
  PendingUserEvent,
  StableEnvelope,
  ToolCall,
  WorkflowEventEntry,
} from '@/features/chat/types';

// Hide non-actionable Claude Code bookkeeping rows from the main chat.
// The raw JSONL envelopes still remain in `events` for telemetry, replay,
// remote-control state, and future debug surfaces; this is render-only.
const SUPPRESSED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'bridge_status',
  'init',
  'session_state_changed',
  'stop_hook_summary',
  'compact_boundary',
  'microcompact_boundary',
  'turn_duration',
  'post_turn_summary',
]);

// CC's `Notification` hook fires for idle prompts, OS-toast messages, and
// other non-actionable noise. Suppress the ones that have a dedicated UI
// elsewhere (the prompt-waiting indicator lives in the input footer) — they
// stay in JSONL for telemetry / OS-level notification routing.
const SUPPRESSED_NOTIFICATION_PATTERNS: readonly RegExp[] = [
  /is waiting for your input/i,
  /is no longer responding to user input/i,
];

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
  onSend: (text: string, clientMessageId: string) => boolean;
  /** Composer interrupt. */
  onInterrupt: () => boolean;
  /** Raw xterm input. Present only on the live orchestrator surface. */
  onTerminalInput?: (data: string) => boolean;
  /** Terminal resize. Present only on the live orchestrator surface. */
  onTerminalResize?: (cols: number, rows: number) => boolean;
  /** Optional ask-card reply (orchestrator only — wires to WS `ask-reply`).
   *  When omitted, ask cards never appear because the session-id filter drops
   *  them; safe to leave undefined for agent-designer surface. */
  onAskReply?: (toolUseId: string, answer: string) => boolean;
  /** localStorage partition for prompt history (per-project / per-surface). */
  composerHistoryKey: string;
  defaultOrchestratorSurface?: OrchestratorSurfacePreference;
  /** Hide composer entirely — past-session view. */
  composerHidden?: boolean;
  /** Disable composer input + send/interrupt buttons. Used for agent-designer
   *  spawn / exited states where the composer is structurally present but
   *  input isn't yet (or no longer) accepted. */
  composerDisabled?: boolean;
  /** Keep the textarea editable, but prevent submitting. Used during a
   *  new-session transition so drafts don't leak into the previous session. */
  composerSendDisabled?: boolean;
  /** Controls whether raw xterm input may reach the runtime. Defaults to the
   *  same availability gates as the composer and live WS. */
  terminalWritable?: boolean;
  /** Override composer placeholder. Defaults to the orchestrator string. */
  composerPlaceholder?: string;
  /** User-facing reason when the composer is disabled but still visible. */
  composerDisabledReason?: string;
  /** Server-derived queueable runtime state (busy/spawning/respawning). */
  composerQueueing?: boolean;
  /** Server-derived send button label. */
  composerSendLabel?: string;
  /** Non-blocking status text shown in the composer chrome. */
  composerStatusMessage?: string;
  /** Optional content above the chat scroller (session title row, agent label, etc.). */
  headerSlot?: ReactNode;
  /** Optional content between scroller and composer (e.g. session-ended notice). */
  bannerSlot?: ReactNode;
  /** Optional content below composer (e.g. StatusBar). */
  footerSlot?: ReactNode;
  /** Content rendered when there are no events to show. */
  emptyState?: ReactNode;
  /** Connection status of the WS feeding `events`. When the socket drops
   *  mid-turn the thinking indicator shows a "Reconnecting…" notice instead
   *  of a misleading live "Thinking" with a climbing timer. Transient
   *  surfaces that manage their own lifecycle omit this. */
  wsStatus?: WsStatus;
  /** Reports the active surface to parent shells that need to adapt their
   *  surrounding layout, such as hiding side previews while xterm is active. */
  onSurfaceModeChange?: (mode: OrchestratorSurfacePreference) => void;
}

export function ChatSurface({
  events,
  projectId,
  currentSessionId,
  onSend,
  onInterrupt,
  onTerminalInput,
  onTerminalResize,
  onAskReply,
  composerHistoryKey,
  defaultOrchestratorSurface = 'chat',
  composerHidden,
  composerDisabled,
  composerSendDisabled,
  terminalWritable,
  composerPlaceholder,
  composerDisabledReason,
  composerQueueing,
  composerSendLabel,
  composerStatusMessage,
  headerSlot,
  bannerSlot,
  footerSlot,
  emptyState,
  wsStatus,
  onSurfaceModeChange,
}: ChatSurfaceProps) {
  const { visiblePendingPrompts, recordPendingPrompt } = usePendingPrompts({
    events,
    currentSessionId,
  });
  const terminalEligible = Boolean(
    onTerminalInput &&
      onTerminalResize &&
      currentSessionId &&
      !composerHidden,
  );
  const [surfaceMode, setSurfaceMode] =
    useState<OrchestratorSurfacePreference>('chat');
  const [surfaceModeReady, setSurfaceModeReady] = useState(false);
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

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
    for (let i = 0; i < visiblePendingPrompts.length; i++) {
      const pending = visiblePendingPrompts[i]!;
      out.push({
        origIdx: eventsWithTodos.length + i,
        key: `pending-${pending.id}`,
        env: pendingPromptEnvelope(projectId, pending),
      });
    }
    return out;
  }, [events, currentSessionId, projectId, visiblePendingPrompts]);

  const renderItems = useMemo(
    () => synthesizeRenderItems(chatEnvelopes),
    [chatEnvelopes],
  );

  const [resolvedApprovals, setResolvedApprovals] = useState<
    Record<string, { approved: boolean; response: string }>
  >({});
  const [answeredAsks, setAnsweredAsks] = useState<Record<string, string>>({});

  const liveState = useMemo(() => deriveLiveState(events), [events]);
  const jsonlBusy = useMemo(() => deriveJsonlBusy(events), [events]);
  const isThinking = isRuntimeThinking(liveState, jsonlBusy);
  const activity = useMemo(() => deriveActivity(events), [events]);

  // Liveness proxy: timestamp of the most recent envelope of any kind. During
  // a live turn SOMETHING flows (raw chunks, jsonl, stream events); a growing
  // gap means the agent went quiet — or the process/server died. Drives the
  // "updated Ns ago" readout + the stall hint.
  const [lastEnvelopeAt, setLastEnvelopeAt] = useState<number>(() => Date.now());
  useEffect(() => {
    setLastEnvelopeAt(Date.now());
  }, [events.length]);

  useEffect(() => {
    setSurfaceModeReady(false);
    if (!terminalEligible || !currentSessionId) {
      setSurfaceMode('chat');
      setSurfaceModeReady(true);
      return;
    }
    const stored = readTerminalMode(projectId, currentSessionId);
    setSurfaceMode(stored ?? defaultOrchestratorSurface);
    setSurfaceModeReady(true);
  }, [projectId, currentSessionId, terminalEligible, defaultOrchestratorSurface]);

  const terminalActive = terminalEligible && surfaceMode === 'terminal';
  const resolvedTerminalWritable =
    terminalActive &&
    (terminalWritable ??
      (!composerDisabled &&
        !composerSendDisabled &&
        (wsStatus === undefined || wsStatus === 'open')));
  useEffect(() => {
    if (!surfaceModeReady) return;
    onSurfaceModeChange?.(terminalActive ? 'terminal' : 'chat');
  }, [onSurfaceModeChange, surfaceModeReady, terminalActive]);
  const setTerminalMode = useCallback(
    (next: OrchestratorSurfacePreference) => {
      if (!terminalEligible || !currentSessionId) return;
      setSurfaceMode(next);
      writeTerminalMode(projectId, currentSessionId, next);
    },
    [projectId, currentSessionId, terminalEligible],
  );

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
      const clientMessageId = createClientMessageId();
      const ok = onSend(text, clientMessageId);
      const queueOptimistically = composerQueueing || isThinking;
      if (ok) {
        recordPendingPrompt({
          id: clientMessageId,
          text,
          eventFloor: eventsRef.current.length,
          expectsAck: wsStatus !== undefined,
          queued: queueOptimistically,
        });
      }
      return ok;
    },
    [onSend, composerQueueing, isThinking, wsStatus, recordPendingPrompt],
  );
  const resolvedComposerSendLabel =
    composerSendLabel ??
    (isThinking || composerQueueing ? 'Queue ↵' : 'Send ↵');

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {headerSlot}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollerRef}
          onScroll={handleChatScroll}
          className={
            'h-full overflow-y-auto px-4 py-3 ' +
            (terminalActive ? 'pointer-events-none invisible' : '')
          }
        >
          <div className="flex flex-col gap-3">
            {renderItems.map((item, idx) => {
              if (item.kind === 'tool-group') {
                return (
                  <ChatTurnCard key={item.key} kind="pm" variant="child">
                    <ToolGroupBubble calls={item.calls} />
                  </ChatTurnCard>
                );
              }
              if (item.kind === 'edit') {
                return (
                  <ChatTurnCard key={item.key} kind="pm" variant="child">
                    <EditBubble call={item.call} />
                  </ChatTurnCard>
                );
              }
              if (item.kind === 'workflow-run-group') {
                return (
                  <ChatTurnCard key={item.key} kind="pm" variant="child">
                    <WorkflowRunGroupBubble
                      workflowRunId={item.workflowRunId}
                      events={item.events}
                    />
                  </ChatTurnCard>
                );
              }
              if (item.kind === 'agent-dispatch-group') {
                return (
                  <ChatTurnCard key={item.key} kind="pm" variant="child">
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
                  ts?: string;
                };
                const answered = answeredAsks[askEnv.toolUseId];
                return (
                  <ChatTurnCard
                    key={item.key}
                    kind="pm"
                    ts={askEnv.ts}
                    sub={askEnv.toolName === 'ExitPlanMode' ? 'plan ready' : 'asking'}
                    status="info"
                  >
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
                // Section 31 — subtypes in SUPPRESSED_SYSTEM_SUBTYPES are
                // rendered via their typed envelope instead. Drop the system
                // event entirely so we don't fall through to the ChatTurnCard
                // wrapper and surface an empty bubble with the subtype label.
                if (SUPPRESSED_SYSTEM_SUBTYPES.has(sys.subtype)) {
                  return null;
                }
                if (sys.level !== 'error') {
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
              let sub: string | undefined;
              let status: ChatTurnStatus | undefined;
              let pendingStatus: PendingPromptStatus | undefined;
              if (isPendingUserEvent(ev)) {
                pendingStatus = ev.pendingStatus;
                sub = pendingStatusLabel(ev);
                status = pendingStatusTone(ev.pendingStatus);
                bubbleId = `pending-${ev.pendingClientMessageId}`;
              } else if (ev.kind === 'assistant' && typeof assistantDurationMs === 'number') {
                sub = formatElapsed(assistantDurationMs);
              } else if (ev.kind === 'approval-required') {
                sub = 'approval required';
                status = 'warning';
              } else if (ev.kind === 'subagent-failure') {
                sub = 'subagent failed';
                status = 'danger';
              } else if (ev.kind === 'todos') {
                sub = 'todos';
              } else if (ev.kind === 'task-start') {
                const t = ev as TaskStartEvent;
                sub = t.subagent ? `${t.subagent} · delegated` : 'delegated';
              } else if (ev.kind === 'task-end') {
                const t = ev as TaskEndEvent;
                sub = t.subagent ? `${t.subagent} · returned` : 'returned';
              } else if (ev.kind === 'system') {
                const sys = ev as SystemEvent;
                sub = sys.subtype.replace(/_/g, ' ');
                if (sys.level === 'error') status = 'danger';
              }
              return (
                <ChatTurnCard
                  key={item.key}
                  kind={turnKind}
                  ts={ev.ts}
                  sub={sub}
                  bubbleId={bubbleId}
                  status={status}
                  pendingStatus={pendingStatus}
                  copyText={copyTextForEvent(ev)}
                >
                  <EventBubble
                    event={ev}
                    projectId={projectId}
                    resolvedApprovals={resolvedApprovals}
                    onApprovalResolved={markApprovalResolved}
                  />
                </ChatTurnCard>
              );
            })}
            {chatEnvelopes.length === 0 && emptyState && (
              <div className="text-center text-xs text-muted-foreground">{emptyState}</div>
            )}
            {isThinking && (
              <ThinkingIndicator
                elapsedMs={elapsedMs}
                interruptedAt={interruptedAt}
                activity={activity}
                lastEnvelopeAt={lastEnvelopeAt}
                wsStatus={wsStatus}
              />
            )}
          </div>
        </div>
        {!pinnedToBottom && (!terminalEligible || !terminalActive) && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-3 right-4 z-30 rounded-full px-3.5 py-1.5 text-xs font-bold opacity-100"
            style={{
              backgroundColor: '#f0d080',
              color: '#080604',
              border: '2px solid #080604',
              boxShadow: '0 0 0 1px #f5e8c8, 0 10px 30px rgba(0, 0, 0, 0.7)',
            }}
            title="Scroll to the latest messages"
          >
            ↓ Jump to present
          </button>
        )}
        <TerminalPane
          eligible={terminalEligible}
          projectId={projectId}
          sessionId={currentSessionId}
          events={events}
          active={terminalActive}
          writable={resolvedTerminalWritable}
          onInput={onTerminalInput}
          onResize={onTerminalResize}
        />
      </div>
      {bannerSlot}
      {!composerHidden && !terminalActive && (
        <Composer
          historyKey={composerHistoryKey}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          disabled={composerDisabled}
          sendDisabled={composerSendDisabled}
          placeholder={composerPlaceholder}
          disabledReason={composerDisabledReason}
          statusMessage={composerStatusMessage}
          sendLabel={resolvedComposerSendLabel}
        />
      )}
      <TerminalModeToggle
        eligible={terminalEligible}
        active={terminalActive}
        onModeChange={setTerminalMode}
      />
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

function formatChatTime(ts?: string): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

type ChatTurnStatus = 'warning' | 'info' | 'danger';
type ChatTurnVariant = 'turn' | 'child';

function pendingStatusLabel(event: PendingUserEvent): string {
  const queuedPrefix = event.pendingQueued ? 'queued · ' : '';
  switch (event.pendingStatus) {
    case 'server-received':
      return event.pendingReason ? `${queuedPrefix}sent · ${event.pendingReason}` : `${queuedPrefix}sent`;
    case 'waiting-transcript':
      return event.pendingReason
        ? `${queuedPrefix}waiting for transcript · ${event.pendingReason}`
        : `${queuedPrefix}waiting for transcript`;
    case 'unconfirmed':
      return `${queuedPrefix}send unconfirmed`;
    case 'failed':
      return event.pendingReason ? `${queuedPrefix}not sent · ${event.pendingReason}` : `${queuedPrefix}not sent`;
    case 'sending':
    default:
      return event.pendingQueued ? 'queued' : 'sending';
  }
}

function pendingStatusTone(status: PendingPromptStatus): ChatTurnStatus {
  if (status === 'failed') return 'danger';
  if (status === 'waiting-transcript' || status === 'unconfirmed') return 'warning';
  return 'info';
}

function ChatTurnCard({
  kind,
  ts,
  sub,
  children,
  bubbleId,
  status,
  pendingStatus,
  variant = 'turn',
  copyText,
}: {
  kind: 'user' | 'pm';
  ts?: string;
  sub?: string;
  children: React.ReactNode;
  bubbleId?: string;
  status?: ChatTurnStatus;
  pendingStatus?: PendingPromptStatus;
  variant?: ChatTurnVariant;
  copyText?: string | null;
}) {
  // Child variant: just the smaller card. No avatar / speaker chrome —
  // child renderers (tool group, agent dispatch, workflow run, edit) carry
  // their own header rows.
  if (variant === 'child') {
    return (
      <div className="chat-turn-child" data-bubble-id={bubbleId}>
        {children}
      </div>
    );
  }

  const name = kind === 'user' ? 'You' : 'Claude';
  const avatarText = kind === 'user' ? 'YOU' : 'CC';
  const time = formatChatTime(ts);
  const subParts = [time, sub].filter((x): x is string => Boolean(x));

  const cardClasses = [
    'chat-turn',
    kind === 'user' ? 'chat-turn-user' : '',
    status ? `chat-turn-${status}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="chat-turn-row"
      data-bubble-id={bubbleId}
      data-role={kind === 'user' ? 'user' : 'assistant'}
      data-pending-status={pendingStatus}
    >
      <div className={`chat-avatar${kind === 'user' ? ' chat-avatar-user' : ''}`}>
        {avatarText}
      </div>
      <div className="chat-turn-col">
        <div className="chat-turn-speaker">
          <span className={`chat-turn-name${kind === 'user' ? ' chat-turn-name-user' : ''}`}>
            {name}
          </span>
          {subParts.length > 0 && (
            <span className="chat-turn-sub">{subParts.join(' · ')}</span>
          )}
          {copyText && <CopyButton text={copyText} />}
        </div>
        <div className={cardClasses}>{children}</div>
      </div>
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
      return <UserBubble event={event as UserEvent} projectId={projectId} />;
    case 'assistant':
      return <AssistantBubble event={event as AssistantEvent} projectId={projectId} />;
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
    // Section 31 — typed-envelope renderers for the kept JSONL signals that
    // need distinct visual shapes vs. the generic system-row bubble.
    case 'session-state':
      return <SessionStateDivider event={event as { state: string; permissionMode?: string | null }} />;
    case 'compact-boundary':
      return (
        <CompactBoundaryRule
          event={
            event as {
              trigger?: string | null;
              preTokens?: number | null;
              messagesSummarized?: number | null;
            }
          }
        />
      );
    case 'microcompact':
      return (
        <MicrocompactDivider
          event={
            event as {
              tokensSaved?: number | null;
              preTokens?: number | null;
            }
          }
        />
      );
    case 'turn-footer':
      return (
        <TurnFooterChips
          event={
            event as {
              speed?: string | null;
              cacheMissReason?: string | null;
              model?: string | null;
            }
          }
        />
      );
    case 'notification': {
      const note = event as { message: string; title?: string | null };
      if (
        note.message &&
        SUPPRESSED_NOTIFICATION_PATTERNS.some((re) => re.test(note.message))
      ) {
        return null;
      }
      return <NotificationRow event={note} />;
    }
    case 'session-end':
    case 'subagent-stop':
      return null;
    default:
      return null;
  }
}

function copyTextForEvent(event: ChatEvent): string | null {
  if (event.kind === 'assistant') {
    const text = (event as AssistantEvent).text ?? '';
    return text.trim() ? text : null;
  }
  if (event.kind === 'user') {
    const text = (event as UserEvent).text ?? '';
    const visible = parseUserText(text)
      .filter((p) => p.kind !== 'workflow-event' && p.kind !== 'agent-event')
      .map((p) => p.text)
      .join('');
    return visible.trim() ? visible : null;
  }
  if (event.kind === 'task-end') {
    const text = (event as TaskEndEvent).result ?? '';
    return text.trim() ? text : null;
  }
  return null;
}

function QueueIndicator({ text }: { text: string }) {
  return (
    <div className="self-center px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
      · {text} ·
    </div>
  );
}

// ── Section 31 — JSONL-signal-firehose renderers ─────────────────────────

const SESSION_STATE_LABEL: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  requires_action: 'awaiting input',
};

function SessionStateDivider({
  event,
}: {
  event: { state: string; permissionMode?: string | null };
}) {
  const label = SESSION_STATE_LABEL[event.state] ?? event.state.replace(/_/g, ' ');
  return (
    <div className="self-center flex w-full items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
      <span className="h-px flex-1 bg-border" />
      <span>· {label} ·</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function CompactBoundaryRule({
  event,
}: {
  event: {
    trigger?: string | null;
    preTokens?: number | null;
    messagesSummarized?: number | null;
  };
}) {
  const trigger = event.trigger ? ` ${event.trigger}` : '';
  const tokens =
    typeof event.preTokens === 'number'
      ? ` · ${event.preTokens.toLocaleString()} tokens compacted`
      : '';
  const msgs =
    typeof event.messagesSummarized === 'number'
      ? ` · ${event.messagesSummarized} messages`
      : '';
  return (
    <div className="self-center flex w-full items-center gap-2 px-2 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="px-1">compacted{trigger}{tokens}{msgs}</span>
      <span className="h-px flex-1 border-t border-dashed border-border" />
    </div>
  );
}

function MicrocompactDivider({
  event,
}: {
  event: { tokensSaved?: number | null; preTokens?: number | null };
}) {
  const saved =
    typeof event.tokensSaved === 'number'
      ? `· ${event.tokensSaved.toLocaleString()} tokens freed`
      : '';
  return (
    <div className="self-center flex w-full items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
      <span className="h-px flex-1 bg-border" />
      <span>· microcompact {saved} ·</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

const SPEED_TONE: Record<string, string> = {
  slow: 'border-amber-600/60 bg-amber-950/30 text-amber-200',
  fast: 'border-emerald-600/60 bg-emerald-950/30 text-emerald-200',
};

function NotificationRow({
  event,
}: {
  event: { message: string; title?: string | null };
}) {
  return (
    <div className="self-start flex max-w-[90%] items-center gap-2 border-l-2 border-info bg-info/5 px-2 py-1 text-xs text-foreground">
      <span className="font-mono text-[10px] uppercase tracking-wider text-info">
        {event.title ?? 'Claude'}
      </span>
      <span className="min-w-0 flex-1 truncate">{event.message || '(no message)'}</span>
    </div>
  );
}

function TurnFooterChips({
  event,
}: {
  event: { speed?: string | null; cacheMissReason?: string | null; model?: string | null };
}) {
  const hasSpeed = event.speed && event.speed !== 'standard';
  const hasMiss = !!event.cacheMissReason;
  if (!hasSpeed && !hasMiss) return null;
  return (
    <div className="self-start flex flex-wrap items-center gap-1.5 px-1 text-[10px]">
      {hasSpeed && (
        <span
          className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono uppercase tracking-wider ${
            SPEED_TONE[event.speed!] ?? 'border-border bg-muted text-muted-foreground'
          }`}
          title={event.model ? `${event.speed} · ${event.model}` : event.speed!}
        >
          {event.speed}
        </span>
      )}
      {hasMiss && (
        <span
          className="inline-flex items-center gap-1 border border-amber-600/60 bg-amber-950/30 px-1.5 py-0.5 font-mono uppercase tracking-wider text-amber-200"
          title={`Prompt cache miss · ${event.cacheMissReason}`}
        >
          cache miss · {event.cacheMissReason}
        </span>
      )}
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
    <div className="text-sm">
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
    <div className="text-xs">
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

// Section 32.5 — routine system events render as centered whisper text
// (dotted border, smaller type, muted) so they fade into the chat scroll
// instead of competing with speaker turns. Click to expand details inline;
// errors still get the loud red SystemErrorBubble treatment.
function SystemFooter({ event }: { event: SystemEvent }) {
  const [open, setOpen] = useState(false);
  const previewRaw = event.message.startsWith(`[${event.subtype}]`)
    ? event.message.slice(`[${event.subtype}]`.length).trim()
    : event.message;
  const preview = previewRaw.split('\n')[0] ?? '';
  const hasMore = previewRaw !== preview || event.raw !== undefined;
  return (
    <div className="self-center max-w-[80%] text-[10px] text-muted-foreground/80">
      <button
        type="button"
        onClick={() => hasMore && setOpen((v) => !v)}
        className={`flex w-full items-center justify-center gap-2 border border-dotted border-border/70 px-3 py-0.5 text-center uppercase tracking-[0.06em] ${
          hasMore ? 'hover:border-border hover:text-foreground/80' : 'cursor-default'
        }`}
      >
        <span className="text-muted-foreground/70">
          {event.subtype.replace(/_/g, ' ')}
        </span>
        {preview && (
          <>
            <span className="text-[var(--fg-dim)]">·</span>
            <span className="min-w-0 truncate normal-case tracking-normal italic text-muted-foreground/80">
              {preview}
            </span>
          </>
        )}
        {hasMore && (
          <>
            <span className="text-[var(--fg-dim)]">·</span>
            <span className="shrink-0 text-[var(--fg-dim)] underline-offset-2 hover:underline">
              {open ? 'hide' : 'details'}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className="mt-1 self-center border-l-2 border-border/50 pl-3 text-left normal-case tracking-normal">
          {previewRaw !== preview && (
            <div className="mb-1.5 whitespace-pre-wrap break-words text-foreground/90">
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
  activity,
  lastEnvelopeAt,
  wsStatus,
}: {
  elapsedMs: number;
  interruptedAt: number | null;
  activity: string | null;
  lastEnvelopeAt: number;
  wsStatus?: WsStatus;
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

  // Live "ms since last envelope" so the activity readout reflects real
  // movement and a stall becomes visible (the counter keeps climbing).
  const [sinceEnvelope, setSinceEnvelope] = useState(0);
  useEffect(() => {
    const tick = () => setSinceEnvelope(Date.now() - lastEnvelopeAt);
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [lastEnvelopeAt]);

  // Connection lost mid-turn: don't pretend the agent is working. The socket
  // dropped (server restart / network blip) and reconnects on a backoff.
  const disconnected = wsStatus === 'closed' || wsStatus === 'connecting';
  if (disconnected) {
    return (
      <div className="self-start flex flex-col gap-1 border border-warning/60 bg-warning/10 px-3 py-1.5 text-xs text-warning">
        <div className="flex items-center gap-2">
          <span className="thinking-dots inline-flex items-center gap-0.5">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </span>
          <span>Reconnecting to the app…</span>
        </div>
        <div className="text-[10px] uppercase tracking-wider opacity-90">
          Lost the connection to the local server — retrying. Your chat resumes once it's back.
        </div>
      </div>
    );
  }

  const interrupting = interruptedAt !== null;
  const stuck = interrupting && sinceInterrupt > 5_000;
  const stalled = !interrupting && sinceEnvelope > STALL_WARN_MS;
  const showAgo = !interrupting && sinceEnvelope > 4_000;
  return (
    <div
      className={
        'self-start flex flex-col gap-1 border px-3 py-1.5 text-xs ' +
        (interrupting || stalled
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
      {!interrupting && activity && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="min-w-0 truncate font-mono opacity-90" title={activity}>
            {activity}
          </span>
          {showAgo && (
            <span className="shrink-0 tabular-nums opacity-70">
              · updated {formatElapsed(sinceEnvelope)} ago
            </span>
          )}
        </div>
      )}
      {stalled && (
        <div className="text-[10px] uppercase tracking-wider opacity-90">
          No updates for {formatElapsed(sinceEnvelope)} — Claude may have stopped. Use "+ New session" to reset if it doesn't recover.
        </div>
      )}
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
      title={copied ? 'Copied' : 'Copy to clipboard'}
      aria-label={copied ? 'Copied to clipboard' : 'Copy message to clipboard'}
      className="chat-copy-button"
    >
      <CopyIcon className="h-3 w-3" aria-hidden />
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

// ── User bubble ──────────────────────────────────────────────────────────

function UserBubble({ event, projectId }: { event: UserEvent; projectId: string }) {
  const parts = useMemo(() => {
    const all = parseUserText(event.text ?? '');
    return all.filter((p) => p.kind !== 'workflow-event' && p.kind !== 'agent-event');
  }, [event.text]);
  if (parts.length === 0) return null;
  // Group consecutive non-channel parts (text + rich-link + external-link)
  // into one block so links render inline with their surrounding text.
  const groups: Array<{ kind: 'channel'; part: UserPart } | { kind: 'inline'; parts: UserPart[] }> = [];
  for (const p of parts) {
    if (p.kind === 'channel') {
      groups.push({ kind: 'channel', part: p });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.kind === 'inline') last.parts.push(p);
      else groups.push({ kind: 'inline', parts: [p] });
    }
  }
  return (
    <>
      {groups.map((g, idx) =>
        g.kind === 'channel' ? (
          <div key={idx} className="group relative text-sm">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-warning">
              channel · {g.part.source}
            </div>
            <div className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {g.part.text || '(empty body)'}
            </div>
          </div>
        ) : (
          <div key={idx} className="group relative text-sm text-foreground">
            <div className="whitespace-pre-wrap break-words">
              {g.parts.map((part, j) => renderInlinePart(part, j, projectId)) || '(empty prompt)'}
            </div>
          </div>
        ),
      )}
    </>
  );
}

// Factory for react-markdown's anchor renderer. ProjectId is closed-over so
// hover handlers can route to the preview store. Routes pc:// to RichLink,
// http(s):// to ExternalLink, anything else to a bare anchor.
function makeMarkdownAnchor(projectId: string) {
  return function MarkdownAnchor({
    href,
    children,
  }: {
    href?: string;
    children?: React.ReactNode;
  }) {
    if (!href) return <span>{children}</span>;
    if (href.startsWith('pc://')) {
      const m = href.match(/^pc:\/\/([\w-]+)\/(.+)$/);
      if (m) {
        const kind = m[1] as 'work-item' | 'file' | 'attachment' | 'inbox';
        if (kind === 'work-item' || kind === 'file' || kind === 'attachment' || kind === 'inbox') {
          const ref = decodeURIComponent(m[2] ?? '');
          const text = typeof children === 'string' ? children : '';
          return (
            <LiveRichLink
              kind={kind}
              ref={ref}
              text={text || ref}
              url={href}
              projectId={projectId}
            >
              {children}
            </LiveRichLink>
          );
        }
      }
    }
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return (
        <ExternalLink href={href} insecure={href.startsWith('http://')}>
          {children}
        </ExternalLink>
      );
    }
    return <a href={href}>{children}</a>;
  };
}

function renderInlinePart(part: UserPart, key: number, projectId: string) {
  if (part.kind === 'rich-link' && part.richLinkKind && part.richLinkRef && part.url) {
    return (
      <LiveRichLink
        key={key}
        kind={part.richLinkKind}
        ref={part.richLinkRef}
        text={part.linkText ?? part.text}
        url={part.url}
        projectId={projectId}
      />
    );
  }
  if (part.kind === 'external-link' && part.url) {
    return (
      <ExternalLink
        key={key}
        href={part.url}
        text={part.linkText ?? part.text}
        insecure={part.externalInsecure}
      />
    );
  }
  return <span key={key}>{part.text}</span>;
}

// ── Assistant bubble ─────────────────────────────────────────────────────

function AssistantBubble({ event, projectId }: { event: AssistantEvent; projectId: string }) {
  const text = event.text ?? '';
  if (!text) {
    return (
      <div className="text-sm italic text-muted-foreground">
        {event.transcriptPath
          ? `(no assistant text — transcript empty or missing at ${event.transcriptPath})`
          : '(no transcript path provided by Stop hook)'}
      </div>
    );
  }
  const Anchor = useMemo(() => makeMarkdownAnchor(projectId), [projectId]);
  return (
    <div className="group relative text-sm text-foreground">
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          // react-markdown v10's default urlTransform drops unknown schemes
          // (http / https / mailto / tel only). pc:// gets stripped, so the
          // custom anchor renderer below never sees the href and the rich-
          // link never materialises. Pass through any pc:// + the safe
          // defaults; everything else falls back to react-markdown's behavior.
          urlTransform={passthroughPcUrlTransform}
          components={{ a: Anchor }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** react-markdown's default `urlTransform` drops unknown schemes. We need
 *  pc:// links to reach the custom anchor renderer; defer the rest to the
 *  default behavior (which strips javascript: and similar XSS vectors). */
function passthroughPcUrlTransform(url: string): string {
  if (url.startsWith('pc://')) return url;
  return defaultUrlTransform(url);
}

// react-markdown v10's exported default urlTransform — re-implemented inline
// so we don't depend on it. Mirrors the upstream behavior: allow http(s),
// mailto, tel, irc(s), and a few other safe schemes; strip everything else.
const SAFE_PROTOCOL = /^(?:https?|mailto|tel|ircs?|news|gopher|nntp|feed|fax|ldap[is]?):/i;
function defaultUrlTransform(url: string): string {
  const colon = url.indexOf(':');
  if (colon === -1) return url;
  const question = url.indexOf('?');
  const hash = url.indexOf('#');
  const slash = url.indexOf('/');
  if (
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash)
  ) {
    return url;
  }
  if (SAFE_PROTOCOL.test(url)) return url;
  return '';
}

// ── Tool-calls group ─────────────────────────────────────────────────────

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
          <span className="ml-auto flex items-baseline gap-1.5 text-[10px] italic text-warning">
            running…
            {typeof call.progressElapsedSeconds === 'number' && (
              <span className="not-italic font-mono text-muted-foreground">
                · {formatElapsedSeconds(call.progressElapsedSeconds)}
              </span>
            )}
          </span>
        )}
      </button>
      {open && <ToolCallDetails call={call} />}
    </div>
  );
}

function formatElapsedSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m${r.toString().padStart(2, '0')}s`;
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
    <div className="text-sm">
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
    <div className="text-sm">
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
    <div className="border-l-2 border-accent pl-3 text-sm">
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
    <div className="group relative border-l-2 border-success pl-3 text-sm">
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
    </div>
  );
}
