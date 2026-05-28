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

import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import type {
  ApprovalRequiredEvent,
  ChatEvent,
  SystemEvent,
  TaskEndEvent,
  TaskStartEvent,
  WsEnvelope,
  WsStatus,
} from '@/hooks/use-project-ws';
import { AskCard } from '@/components/AskCard';
import {
  AgentDispatchGroupBubble,
  WorkflowRunGroupBubble,
} from '@/features/chat/AgentWorkflowBubbles';
import { Composer } from '@/features/chat/ChatComposer';
import { ChatTimeline } from '@/features/chat/ChatTimeline';
import {
  ChatTurnCard,
  type ChatTurnStatus,
  copyTextForEvent,
  EventBubble,
  pendingStatusLabel,
  pendingStatusTone,
  SUPPRESSED_SYSTEM_SUBTYPES,
} from '@/features/chat/EventBubbles';
import { TerminalModeToggle, TerminalPane } from '@/features/chat/TerminalPane';
import { formatElapsed, ThinkingIndicator } from '@/features/chat/ThinkingIndicator';
import { EditBubble, ToolGroupBubble } from '@/features/chat/ToolBubbles';
import {
  deriveActivity,
  deriveJsonlBusy,
  deriveLiveState,
  isRuntimeThinking,
  readTerminalMode,
  type RuntimeInputCapabilities,
  writeTerminalMode,
} from '@/features/chat/runtimeState';
import {
  createClientMessageId,
  isPendingUserEvent,
  usePendingPrompts,
} from '@/features/chat/usePendingPrompts';
import { useChatRenderItems } from '@/features/chat/useChatRenderItems';
import type { PendingPromptStatus, RenderItem } from '@/features/chat/types';

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
  /** Override composer placeholder. Defaults to the orchestrator string. */
  composerPlaceholder?: string;
  /** User-facing reason when the composer is disabled but still visible. */
  composerDisabledReason?: string;
  /** Server-derived queueable runtime state (busy/spawning/respawning). */
  composerQueueing?: boolean;
  /** Server-derived send button label. */
  composerSendLabel?: string;
  /** Unified runtime input gate. When supplied, it is the source of truth for
   *  composer send, interrupt, terminal input, and terminal resize. */
  inputCapabilities?: RuntimeInputCapabilities;
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
  composerPlaceholder,
  composerDisabledReason,
  composerQueueing,
  composerSendLabel,
  inputCapabilities,
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

  const { chatEnvelopes, renderItems } = useChatRenderItems({
    events,
    currentSessionId,
    projectId,
    visiblePendingPrompts,
  });

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
  const resolvedComposerDisabled = inputCapabilities
    ? !inputCapabilities.canAcceptChatInput
    : composerDisabled;
  const resolvedComposerSendDisabled = inputCapabilities
    ? !inputCapabilities.canSubmitChatInput
    : composerSendDisabled;
  const resolvedInterruptDisabled = inputCapabilities
    ? !inputCapabilities.canInterrupt
    : false;
  const resolvedTerminalWritable =
    terminalActive &&
    (inputCapabilities?.canAcceptTerminalInput ??
      (!resolvedComposerDisabled &&
        !resolvedComposerSendDisabled &&
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
    if (inputCapabilities && !inputCapabilities.canInterrupt) return false;
    const ok = onInterrupt();
    if (ok && isThinking) setInterruptedAt(Date.now());
    return ok;
  }, [inputCapabilities, onInterrupt, isThinking]);

  const handleSend = useCallback(
    (text: string): boolean => {
      if (inputCapabilities && !inputCapabilities.canSubmitChatInput) return false;
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
    [inputCapabilities, onSend, composerQueueing, isThinking, wsStatus, recordPendingPrompt],
  );
  const handleTerminalResize = useCallback(
    (cols: number, rows: number): boolean => {
      if (inputCapabilities && !inputCapabilities.canResizeTerminal) return false;
      return onTerminalResize?.(cols, rows) ?? false;
    },
    [inputCapabilities, onTerminalResize],
  );
  const resolvedComposerSendLabel =
    composerSendLabel ??
    (isThinking || composerQueueing ? 'Queue ↵' : 'Send ↵');

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

  function renderTimelineItem(item: RenderItem, idx: number): ReactNode {
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
    if (ev.kind === 'system') {
      const sys = ev as SystemEvent;
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
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {headerSlot}
      <ChatTimeline
        renderItems={renderItems}
        autoFollowKey={`${chatEnvelopes.length}:${isThinking ? 1 : 0}`}
        resetKey={currentSessionId}
        empty={chatEnvelopes.length === 0}
        terminalEligible={terminalEligible}
        terminalActive={terminalActive}
        emptyState={emptyState}
        thinkingIndicator={
          isThinking ? (
            <ThinkingIndicator
              elapsedMs={elapsedMs}
              interruptedAt={interruptedAt}
              activity={activity}
              lastEnvelopeAt={lastEnvelopeAt}
              wsStatus={wsStatus}
            />
          ) : undefined
        }
        terminalPane={
          <TerminalPane
            eligible={terminalEligible}
            projectId={projectId}
            sessionId={currentSessionId}
            events={events}
            active={terminalActive}
            writable={resolvedTerminalWritable}
            onInput={onTerminalInput}
            onResize={handleTerminalResize}
          />
        }
        renderItem={renderTimelineItem}
      />
      {bannerSlot}
      {!composerHidden && !terminalActive && (
        <Composer
          historyKey={composerHistoryKey}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          disabled={resolvedComposerDisabled}
          sendDisabled={resolvedComposerSendDisabled}
          interruptDisabled={resolvedInterruptDisabled}
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
