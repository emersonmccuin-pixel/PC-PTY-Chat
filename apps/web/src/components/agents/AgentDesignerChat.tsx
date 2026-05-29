// Thin wrapper around <ChatSurface>. The agent-designer transient PtySession
// broadcasts on the same project WS as the orchestrator but with its own
// envelope kinds (`agent-designer-state` / `agent-designer-jsonl` /
// `agent-designer-exit`). The adapter below translates those into the
// per-project envelope shapes ChatSurface already understands, then the
// wrapper renders ChatSurface with HTTP-routed send/interrupt + a header
// label + an appropriate composer-disabled state.
//
// Parent (CreatePodModal) is responsible for calling transientSessionsApi.startAgentDesigner
// before mounting + transientSessionsApi.stopAgentDesigner on modal close. Cleanup is NOT
// in a useEffect cleanup because React 18 Strict Mode double-invokes mount/
// cleanup and would kill the freshly-spawned claude.exe within ~50ms — see
// [[strict-mode-useeffect-kills-external-resource]].

import { useMemo } from 'react';

import type { Project } from '@/features/projects/client';
import { transientInputCapabilities } from '@/features/chat/runtimeState';
import { transientSessionsApi } from '@/features/transient-sessions/client';
import {
  adaptTransientEvents,
  isTransientSessionState,
  isWarmupOkUserText,
  type TransientSessionState,
} from '@/features/transient-sessions/events';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { TransientAgentConversation } from '@/components/TransientAgentConversation';

export type AgentDesignerState = TransientSessionState;

interface AgentDesignerChatProps {
  project: Project;
  events: WsEnvelope[];
  sessionId: string | null;
  initialState?: AgentDesignerState;
}

export function isAgentDesignerState(value: unknown): value is AgentDesignerState {
  return isTransientSessionState(value);
}

export function AgentDesignerChat({
  project,
  events,
  sessionId,
  initialState = 'spawning',
}: AgentDesignerChatProps) {
  const { envelopes, state } = useMemo(
    () =>
      adaptTransientEvents({
        events,
        projectId: project.id,
        sessionId,
        initialState,
        prefix: 'agent-designer',
        hiddenUserText: (text) =>
          isWarmupOkUserText(text) ? 'drop-with-next-turn-end' : false,
      }),
    [events, project.id, sessionId, initialState],
  );

  const emptyState =
    state === 'spawning'
      ? 'Starting agent-designer…'
      : state === 'exited'
        ? 'Session ended.'
        : 'Ready. Type below to start the conversation.';

  const composerPlaceholder =
    state === 'spawning'
      ? 'Waiting for session to start…'
      : state === 'exited'
        ? 'Session ended. Close to dismiss.'
        : 'Type your reply. Enter sends, Shift+Enter for a newline.';

  return (
    <TransientAgentConversation
      events={envelopes}
      projectId={project.id}
      sessionId={sessionId}
      title={<span className="text-foreground">agent-designer</span>}
      titleText="agent-designer"
      statusLabel={stateLabel(state)}
      onSend={(text) => {
        void transientSessionsApi.sendAgentDesigner(project.id, text).catch(() => {
          /* error surfaced in the next event broadcast or composer ui */
        });
        // Optimistic — actual delivery confirmed via the jsonl-user envelope.
        return true;
      }}
      onInterrupt={() => {
        void transientSessionsApi.interruptAgentDesigner(project.id).catch(() => {
          /* best-effort */
        });
        return true;
      }}
      onTerminalInput={(data) => {
        void transientSessionsApi.sendAgentDesignerTerminalInput(project.id, data).catch(() => {
          /* best-effort; terminal input acks are not surfaced in this shell */
        });
        return true;
      }}
      onTerminalResize={(cols, rows) => {
        void transientSessionsApi.resizeAgentDesigner(project.id, cols, rows).catch(() => {
          /* best-effort */
        });
        return true;
      }}
      composerHistoryKey={`agent-designer:${project.id}`}
      inputCapabilities={transientInputCapabilities(state)}
      composerPlaceholder={composerPlaceholder}
      emptyState={emptyState}
    />
  );
}

function stateLabel(state: AgentDesignerState): string {
  switch (state) {
    case 'spawning':
      return 'Starting…';
    case 'thinking':
      return 'Thinking…';
    case 'exited':
      return 'Session ended';
    case 'ready':
    default:
      return 'Ready';
  }
}
