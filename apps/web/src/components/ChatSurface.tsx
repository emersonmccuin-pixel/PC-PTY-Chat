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
import type { WsEnvelope, WsStatus } from '@/hooks/use-project-ws';
import { Composer } from '@/features/chat/ChatComposer';
import { ChatTimeline } from '@/features/chat/ChatTimeline';
import { TerminalModeToggle, TerminalPane } from '@/features/chat/TerminalPane';
import { ThinkingIndicator } from '@/features/chat/ThinkingIndicator';
import {
  deriveJsonlBusy,
  deriveLiveState,
  isRuntimeThinking,
  readTerminalMode,
  type RuntimeInputCapabilities,
  writeTerminalMode,
} from '@/features/chat/runtimeState';
import {
  createClientMessageId,
  usePendingPrompts,
} from '@/features/chat/usePendingPrompts';
import { useChatRenderItems } from '@/features/chat/useChatRenderItems';
import { useChatTimelineRenderer } from '@/features/chat/useChatTimelineRenderer';
import { useThinkingIndicatorState } from '@/features/chat/useThinkingIndicatorState';

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

  const renderTimelineItem = useChatTimelineRenderer({
    projectId,
    renderItems,
    onAskReply,
  });

  const liveState = useMemo(() => deriveLiveState(events), [events]);
  const jsonlBusy = useMemo(() => deriveJsonlBusy(events), [events]);
  const isThinking = isRuntimeThinking(liveState, jsonlBusy);
  const {
    activity,
    elapsedMs,
    interruptedAt,
    lastEnvelopeAt,
    markInterrupted,
  } = useThinkingIndicatorState({ events, isThinking });

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

  const handleInterrupt = useCallback((): boolean => {
    if (inputCapabilities && !inputCapabilities.canInterrupt) return false;
    const ok = onInterrupt();
    if (ok) markInterrupted();
    return ok;
  }, [inputCapabilities, onInterrupt, markInterrupted]);

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
