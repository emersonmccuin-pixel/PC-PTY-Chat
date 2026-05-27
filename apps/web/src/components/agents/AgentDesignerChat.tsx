// Thin wrapper around <ChatSurface>. The agent-designer transient PtySession
// broadcasts on the same project WS as the orchestrator but with its own
// envelope kinds (`agent-designer-state` / `agent-designer-jsonl` /
// `agent-designer-exit`). The adapter below translates those into the
// per-project envelope shapes ChatSurface already understands, then the
// wrapper renders ChatSurface with HTTP-routed send/interrupt + a header
// label + an appropriate composer-disabled state.
//
// Parent (CreatePodModal) is responsible for calling api.startAgentDesigner
// before mounting + api.stopAgentDesigner on modal close. Cleanup is NOT
// in a useEffect cleanup because React 18 Strict Mode double-invokes mount/
// cleanup and would kill the freshly-spawned claude.exe within ~50ms — see
// [[strict-mode-useeffect-kills-external-resource]].

import { useMemo } from 'react';

import { api, type Project } from '@/api/client';
import type { JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';
import { TransientAgentConversation } from '@/components/TransientAgentConversation';

export type AgentDesignerState = 'spawning' | 'ready' | 'thinking' | 'exited';

interface AgentDesignerChatProps {
  project: Project;
  events: WsEnvelope[];
  sessionId: string | null;
}

/** Warmup-turn user prompt from agent-run-manager. Filtered from the chat. */
function isWarmupUserText(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed === 'reply with only the word ok.' ||
    trimmed === 'reply with only the word ok' ||
    trimmed.startsWith('reply with only the word ok')
  );
}

interface AdapterResult {
  envelopes: WsEnvelope[];
  state: AgentDesignerState;
}

/** Translate agent-designer-* envelopes into the per-project shapes
 *  ChatSurface understands. Also collapses the lifecycle into a single
 *  AgentDesignerState used for composer-disabled + header label. */
function adaptAgentDesignerEvents(
  events: WsEnvelope[],
  projectId: string,
  sessionId: string | null,
): AdapterResult {
  const out: WsEnvelope[] = [];
  let state: AgentDesignerState = 'spawning';
  let skipNextAssistant = false;
  for (const env of events) {
    if (env.type === 'agent-designer-state') {
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
    if (env.type === 'agent-designer-jsonl') {
      if (!belongsToSession(env, sessionId)) continue;
      const ev = (env as { event?: JsonlEvent }).event;
      if (!ev) continue;
      // Filter the warmup turn pair (synthetic prompt from Section 20.C).
      if (ev.kind === 'jsonl-user' && ev.text && isWarmupUserText(ev.text)) {
        skipNextAssistant = true;
        continue;
      }
      if (ev.kind === 'jsonl-turn-end' && skipNextAssistant) {
        skipNextAssistant = false;
        continue;
      }
      out.push({ projectId, type: 'jsonl', event: ev });
      continue;
    }
    if (env.type === 'agent-designer-exit') {
      if (!belongsToSession(env, sessionId)) continue;
      state = 'exited';
      // No envelope translation — composerDisabled handles user-facing state.
      continue;
    }
    if (env.type === 'agent-designer-raw') {
      const rawSessionId = (env as { sessionId?: unknown }).sessionId;
      if (sessionId && rawSessionId === sessionId) {
        out.push({ ...env, projectId, type: 'raw', sessionId });
      }
      continue;
    }
    // Anything else (orchestrator events on the same WS) doesn't belong on
    // the agent-designer surface.
  }
  return { envelopes: out, state };
}

function belongsToSession(env: WsEnvelope, sessionId: string | null): boolean {
  if (!sessionId) return true;
  return (env as { sessionId?: unknown }).sessionId === sessionId;
}

export function AgentDesignerChat({
  project,
  events,
  sessionId,
}: AgentDesignerChatProps) {
  const { envelopes, state } = useMemo(
    () => adaptAgentDesignerEvents(events, project.id, sessionId),
    [events, project.id, sessionId],
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
        void api.sendAgentDesigner(project.id, text).catch(() => {
          /* error surfaced in the next event broadcast or composer ui */
        });
        // Optimistic — actual delivery confirmed via the jsonl-user envelope.
        return true;
      }}
      onInterrupt={() => {
        void api.interruptAgentDesigner(project.id).catch(() => {
          /* best-effort */
        });
        return true;
      }}
      onTerminalInput={(data) => {
        void api.sendAgentDesignerTerminalInput(project.id, data).catch(() => {
          /* best-effort; terminal input acks are not surfaced in this shell */
        });
        return true;
      }}
      onTerminalResize={(cols, rows) => {
        void api.resizeAgentDesigner(project.id, cols, rows).catch(() => {
          /* best-effort */
        });
        return true;
      }}
      composerHistoryKey={`agent-designer:${project.id}`}
      composerDisabled={state === 'spawning' || state === 'exited'}
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
