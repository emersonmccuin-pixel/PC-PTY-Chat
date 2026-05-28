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
import { transientSessionsApi } from '@/features/transient-sessions/client';
import type { JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';
import { TransientAgentConversation } from '@/components/TransientAgentConversation';

export type WorkflowBuilderState = 'spawning' | 'ready' | 'thinking' | 'exited';

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

function isWarmupUserText(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed.startsWith('reply with only the word ok');
}

interface AdapterResult {
  envelopes: WsEnvelope[];
  state: WorkflowBuilderState;
}

function adaptWorkflowBuilderEvents(
  events: WsEnvelope[],
  projectId: string,
  sessionId: string | null,
  initialState: WorkflowBuilderState,
): AdapterResult {
  const out: WsEnvelope[] = [];
  let state = initialState;
  let skipNextAssistant = false;
  for (const env of events) {
    if (env.type === 'workflow-builder-state') {
      if (!belongsToSession(env, sessionId)) continue;
      const s = (env as { state?: string }).state;
      if (s === 'spawning' || s === 'ready' || s === 'thinking' || s === 'exited') {
        state = s;
      }
      if (s === 'ready' || s === 'thinking') {
        out.push({ projectId, type: 'state', state: s });
      }
      continue;
    }
    if (env.type === 'workflow-builder-jsonl') {
      if (!belongsToSession(env, sessionId)) continue;
      const ev = (env as { event?: JsonlEvent }).event;
      if (!ev) continue;
      if (ev.kind === 'jsonl-user' && ev.text) {
        if (ev.text.startsWith(EDIT_HANDOFF_PREFIX) || isWarmupUserText(ev.text)) {
          skipNextAssistant = isWarmupUserText(ev.text);
          continue;
        }
      }
      if (ev.kind === 'jsonl-turn-end' && skipNextAssistant) {
        skipNextAssistant = false;
        continue;
      }
      out.push({ projectId, type: 'jsonl', event: ev });
      continue;
    }
    if (env.type === 'workflow-builder-exit') {
      if (!belongsToSession(env, sessionId)) continue;
      state = 'exited';
      continue;
    }
    if (env.type === 'workflow-builder-raw') {
      const rawSessionId = (env as { sessionId?: unknown }).sessionId;
      if (sessionId && rawSessionId === sessionId) {
        out.push({ ...env, projectId, type: 'raw', sessionId });
      }
      continue;
    }
    if (env.type === 'ask') {
      const askSessionId = (env as { sessionId?: string | null }).sessionId;
      if (sessionId && askSessionId === sessionId) {
        out.push(env);
      }
      continue;
    }
  }
  return { envelopes: out, state };
}

function belongsToSession(env: WsEnvelope, sessionId: string | null): boolean {
  if (!sessionId) return true;
  return (env as { sessionId?: unknown }).sessionId === sessionId;
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
    () => adaptWorkflowBuilderEvents(events, projectId, sessionId, initialState),
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
      composerDisabled={state === 'spawning' || state === 'exited'}
      terminalWritable={state === 'ready'}
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
