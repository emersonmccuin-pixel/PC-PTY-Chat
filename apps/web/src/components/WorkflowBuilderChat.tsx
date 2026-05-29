// Section 19.10 — Thin wrapper around <ChatSurface> for the v2 workflow-
// builder modal. The v2 analogue of WorkflowDesignerChat — same shape,
// different envelope kinds (`workflow-builder-*` instead of
// `workflow-creator-*`).
//
// Two filters specific to this surface:
//   - the edit-mode handoff user message (`[edit-mode workflowId="…"]`) is
//     dropped from the chat so the user sees a clean conversation.
//   - the warmup-turn pair (defensive parity with AgentDesignerChat).
//
// Parent (WorkflowBuilderModal) owns session lifecycle: it calls
// transientSessionsApi.startWorkflowBuilder before mounting + transientSessionsApi.stopWorkflowBuilder on close.
// Cleanup is NOT in a useEffect cleanup here — see
// [[strict-mode-useeffect-kills-external-resource]].

import { useMemo } from 'react';

import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import { transientInputCapabilities } from '@/features/chat/runtimeState';
import { transientSessionsApi } from '@/features/transient-sessions/client';
import {
  adaptTransientEvents,
  isWarmupOkUserText,
  type TransientSessionState,
} from '@/features/transient-sessions/events';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { TransientAgentConversation } from '@/components/TransientAgentConversation';

export type WorkflowBuilderState = TransientSessionState;

/** First user message in an edit-mode session starts with this — the model
 *  uses it to switch behavior; the chat panel hides it. Kept in sync with the
 *  constant in WorkflowBuilderModal.tsx. */
const EDIT_HANDOFF_PREFIX = '[edit-mode workflowId=';

interface WorkflowBuilderChatProps {
  projectId: string;
  events: WsEnvelope[];
  /** Transient PC_SESSION_ID for this workflow-builder session. Scopes ask
   *  cards so other transient sessions don't bleed into this surface. Null
   *  until the start response resolves. */
  sessionId: string | null;
  /** Reply to an AskUserQuestion pick — wired to the modal's WS `ask-reply`. */
  onAskReply: (toolUseId: string, answer: string) => boolean;
  initialState?: WorkflowBuilderState;
  title: string;
  subtitle: string;
  statusLabel?: string;
  onClose: () => void;
  onSurfaceModeChange?: (mode: OrchestratorSurfacePreference) => void;
}

export function WorkflowBuilderChat({
  projectId,
  events,
  sessionId,
  onAskReply,
  initialState = 'spawning',
  title,
  subtitle,
  statusLabel,
  onClose,
  onSurfaceModeChange,
}: WorkflowBuilderChatProps) {
  const { envelopes, state } = useMemo(
    () =>
      adaptTransientEvents({
        events,
        projectId,
        sessionId,
        initialState,
        prefix: 'workflow-builder',
        includeAsk: true,
        hiddenUserText: (text) => {
          if (text.startsWith(EDIT_HANDOFF_PREFIX)) return 'drop';
          return isWarmupOkUserText(text) ? 'drop-with-next-turn-end' : false;
        },
      }),
    [events, projectId, sessionId, initialState],
  );

  const emptyState =
    state === 'spawning'
      ? 'Starting workflow-builder…'
      : state === 'exited'
        ? 'Session ended.'
        : 'Tell the workflow-builder what you want this workflow to do. It will interview you, draft the workflow, and publish when you confirm.';

  const composerPlaceholder =
    state === 'spawning'
      ? 'Waiting for session to start…'
      : state === 'exited'
        ? 'Session ended. Close to dismiss.'
        : 'Describe the workflow you want. Enter sends, Shift+Enter for a newline.';

  return (
    <TransientAgentConversation
      events={envelopes}
      projectId={projectId}
      sessionId={sessionId}
      title={<span className="text-foreground">{title}</span>}
      titleText={title}
      subtitle={subtitle}
      statusLabel={statusLabel ?? stateLabel(state)}
      onClose={onClose}
      onSend={(text) => {
        void transientSessionsApi.sendWorkflowBuilder(projectId, text).catch(() => {
          /* surfaced in the next event broadcast or composer ui */
        });
        return true;
      }}
      onInterrupt={() => {
        void transientSessionsApi.interruptWorkflowBuilder(projectId).catch(() => {
          /* best-effort */
        });
        return true;
      }}
      onTerminalInput={(data) => {
        void transientSessionsApi.sendWorkflowBuilderTerminalInput(projectId, data).catch(() => {
          /* best-effort; terminal input errors are not rendered inline */
        });
        return true;
      }}
      onTerminalResize={(cols, rows) => {
        void transientSessionsApi.resizeWorkflowBuilder(projectId, cols, rows).catch(() => {
          /* best-effort */
        });
        return true;
      }}
      onAskReply={onAskReply}
      composerHistoryKey={`workflow-builder:${projectId}`}
      inputCapabilities={transientInputCapabilities(state)}
      composerPlaceholder={composerPlaceholder}
      emptyState={emptyState}
      onSurfaceModeChange={onSurfaceModeChange}
    />
  );
}

function stateLabel(state: WorkflowBuilderState): string {
  switch (state) {
    case 'spawning':
      return 'Starting...';
    case 'thinking':
      return 'Thinking...';
    case 'exited':
      return 'Session ended';
    case 'ready':
    default:
      return 'Ready';
  }
}
