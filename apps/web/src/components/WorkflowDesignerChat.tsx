// Thin wrapper around <ChatSurface> for the conversational workflow-creator
// modal — the workflow analogue of AgentDesignerChat. The workflow-creator
// transient PtySession broadcasts on the project WS with its own envelope
// kinds (`workflow-creator-state` / `workflow-creator-jsonl` /
// `workflow-creator-exit`) plus `ask` envelopes (AskUserQuestion picks). The
// adapter below translates those into the per-project envelope shapes
// ChatSurface already understands, then renders ChatSurface with HTTP-routed
// send/interrupt + WS-routed ask replies.
//
// Two filters specific to the workflow surface:
//   - the edit-mode handoff user message (`[edit-mode workflowId="…"]`) is
//     dropped from the chat so the user sees a clean conversation (the model
//     still received it — it was sent via the API).
//   - the warmup-turn pair (defensive; the transient spawn doesn't actually
//     inject one today, same as AgentDesignerChat).
//
// Parent (CreateWorkflowModal) owns session lifecycle: it calls
// api.startWorkflowCreator before mounting + api.stopWorkflowCreator on close.
// Cleanup is NOT in a useEffect cleanup here — see
// [[strict-mode-useeffect-kills-external-resource]].

import { useMemo } from 'react';

import { api } from '@/api/client';
import type { JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';
import { ChatSurface } from '@/components/ChatSurface';

export type WorkflowDesignerState = 'spawning' | 'ready' | 'thinking' | 'exited';

/** First user message in an edit-mode session starts with this — the model
 *  uses it to switch behavior; the chat panel hides it. Kept in sync with the
 *  constant in CreateWorkflowModal.tsx. */
const EDIT_HANDOFF_PREFIX = '[edit-mode workflowId=';

interface WorkflowDesignerChatProps {
  projectId: string;
  events: WsEnvelope[];
  /** Transient PC_SESSION_ID for this workflow-creator session. Scopes ask
   *  cards so the orchestrator's (or another transient session's) asks don't
   *  bleed into this surface. Null until the start response resolves. */
  sessionId: string | null;
  /** Reply to an AskUserQuestion pick — wired to the modal's WS `ask-reply`. */
  onAskReply: (toolUseId: string, answer: string) => boolean;
}

/** Warmup-turn user prompt (defensive parity with AgentDesignerChat). */
function isWarmupUserText(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed.startsWith('reply with only the word ok');
}

interface AdapterResult {
  envelopes: WsEnvelope[];
  state: WorkflowDesignerState;
}

/** Translate workflow-creator-* envelopes into the per-project shapes
 *  ChatSurface understands. Passes `ask` envelopes through unchanged (scoped
 *  to our session) so ChatSurface renders them as AskCards. Collapses the
 *  lifecycle into a single WorkflowDesignerState. */
function adaptWorkflowCreatorEvents(
  events: WsEnvelope[],
  projectId: string,
  sessionId: string | null,
): AdapterResult {
  const out: WsEnvelope[] = [];
  let state: WorkflowDesignerState = 'spawning';
  let skipNextAssistant = false;
  for (const env of events) {
    if (env.type === 'workflow-creator-state') {
      const s = (env as { state?: string }).state;
      if (s === 'spawning' || s === 'ready' || s === 'thinking' || s === 'exited') {
        state = s;
      }
      if (s === 'ready' || s === 'thinking') {
        out.push({ projectId, type: 'state', state: s });
      }
      continue;
    }
    if (env.type === 'workflow-creator-jsonl') {
      const ev = (env as { event?: JsonlEvent }).event;
      if (!ev) continue;
      if (ev.kind === 'jsonl-user' && ev.text) {
        // Hide the edit-mode handoff + the (defensive) warmup turn.
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
    if (env.type === 'workflow-creator-exit') {
      state = 'exited';
      continue;
    }
    if (env.type === 'ask') {
      // Pass through asks for OUR session only. ChatSurface re-filters by
      // currentSessionId, but pre-filtering keeps stale broadcasts out.
      const askSessionId = (env as { sessionId?: string | null }).sessionId;
      if (sessionId && askSessionId === sessionId) {
        out.push(env);
      }
      continue;
    }
    // Anything else (orchestrator events on the same WS) isn't ours.
  }
  return { envelopes: out, state };
}

export function WorkflowDesignerChat({
  projectId,
  events,
  sessionId,
  onAskReply,
}: WorkflowDesignerChatProps) {
  const { envelopes, state } = useMemo(
    () => adaptWorkflowCreatorEvents(events, projectId, sessionId),
    [events, projectId, sessionId],
  );

  const emptyState =
    state === 'spawning'
      ? 'Starting workflow-creator…'
      : state === 'exited'
        ? 'Session ended.'
        : 'Tell the workflow-creator what you want this workflow to do. It will interview you, draft the workflow, and commit when you confirm.';

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
        void api.sendWorkflowCreator(projectId, text).catch(() => {
          /* surfaced in the next event broadcast or composer ui */
        });
        return true;
      }}
      onInterrupt={() => {
        void api.interruptWorkflowCreator(projectId).catch(() => {
          /* best-effort */
        });
        return true;
      }}
      onAskReply={onAskReply}
      composerHistoryKey={`workflow-creator:${projectId}`}
      composerDisabled={state === 'spawning' || state === 'exited'}
      composerPlaceholder={composerPlaceholder}
      emptyState={emptyState}
    />
  );
}
