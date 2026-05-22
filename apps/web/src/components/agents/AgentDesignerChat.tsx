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
import { ChatSurface } from '@/components/ChatSurface';

export type AgentDesignerState = 'spawning' | 'ready' | 'thinking' | 'exited';

interface AgentDesignerChatProps {
  project: Project;
  events: WsEnvelope[];
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
): AdapterResult {
  const out: WsEnvelope[] = [];
  let state: AgentDesignerState = 'spawning';
  let skipNextAssistant = false;
  for (const env of events) {
    if (env.type === 'agent-designer-state') {
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
      state = 'exited';
      // No envelope translation — composerDisabled handles user-facing state.
      continue;
    }
    // Anything else (orchestrator events on the same WS) doesn't belong on
    // the agent-designer surface.
  }
  return { envelopes: out, state };
}

export function AgentDesignerChat({ project, events }: AgentDesignerChatProps) {
  const { envelopes, state } = useMemo(
    () => adaptAgentDesignerEvents(events, project.id),
    [events, project.id],
  );

  const headerSlot = (
    <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        agent-designer
      </span>
      <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {stateLabel(state)}
      </span>
    </div>
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
    <ChatSurface
      events={envelopes}
      projectId={project.id}
      // No session id for transient agent-designer sessions; the project
      // WS doesn't broadcast ask cards to this surface (the pod doesn't
      // call pc_ask_*), so the ask-filter is effectively a no-op.
      currentSessionId={null}
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
      composerHistoryKey={`agent-designer:${project.id}`}
      composerDisabled={state === 'spawning' || state === 'exited'}
      composerPlaceholder={composerPlaceholder}
      headerSlot={headerSlot}
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
