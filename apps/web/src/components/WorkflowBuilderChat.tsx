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
// api.startWorkflowBuilder before mounting + api.stopWorkflowBuilder on close.
// Cleanup is NOT in a useEffect cleanup here — see
// [[strict-mode-useeffect-kills-external-resource]].

import { useMemo } from 'react';

import { api } from '@/api/client';
import type { JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';
import { ChatSurface } from '@/components/ChatSurface';

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
): AdapterResult {
  const out: WsEnvelope[] = [];
  let state: WorkflowBuilderState = 'spawning';
  let skipNextAssistant = false;
  for (const env of events) {
    if (env.type === 'workflow-builder-state') {
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
      state = 'exited';
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

export function WorkflowBuilderChat({
  projectId,
  events,
  sessionId,
  onAskReply,
}: WorkflowBuilderChatProps) {
  const { envelopes, state } = useMemo(
    () => adaptWorkflowBuilderEvents(events, projectId, sessionId),
    [events, projectId, sessionId],
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
    <ChatSurface
      events={envelopes}
      projectId={projectId}
      currentSessionId={sessionId}
      onSend={(text) => {
        void api.sendWorkflowBuilder(projectId, text).catch(() => {
          /* surfaced in the next event broadcast or composer ui */
        });
        return true;
      }}
      onInterrupt={() => {
        void api.interruptWorkflowBuilder(projectId).catch(() => {
          /* best-effort */
        });
        return true;
      }}
      onAskReply={onAskReply}
      composerHistoryKey={`workflow-builder:${projectId}`}
      composerDisabled={state === 'spawning' || state === 'exited'}
      composerPlaceholder={composerPlaceholder}
      emptyState={emptyState}
    />
  );
}
