// 17b.12 — AgentDesignerSessionModal as a transient-session chat.
//
// Architectural shape: same as Orchestrator chat or the legacy
// CreateAgentModal — a free-form text conversation against a dedicated
// PtySession running agent-designer's pod. Always-on text input. No
// pause/answer dance, no dispatch/run lifecycle.
//
// Server contract (17b.12):
//   - POST /api/projects/:projectId/agent-designer/start
//       starts the transient PtySession with `--agent agent-designer`.
//       The orchestrator's pc_open_agent_designer MCP tool calls this
//       AND seeds the first user message via /send.
//   - POST /api/projects/:projectId/agent-designer/send  { text }
//       sends a user message into the chat.
//   - POST /api/projects/:projectId/agent-designer/interrupt
//       interrupts a thinking turn (Ctrl+C equivalent).
//   - DELETE /api/projects/:projectId/agent-designer
//       kills the session + cleans up the materialised pod files.
//
// WS envelopes consumed:
//   agent-designer-state      → spawn/ready/thinking/exited
//   agent-designer-jsonl      → user + turn-end events become bubbles
//   agent-designer-exit       → session terminated
//   project-agents-changed    → auto-close (pc_create_agent fired = pod
//                                made = we're done)
//
// Auto-open: when an agent-designer-state envelope arrives and the modal
// isn't already open, set the store. Auto-close fires on the
// project-agents-changed broadcast (means the pod was committed).

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { Project } from '@/api/client';
import { api } from '@/api/client';
import type { JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';
import { useAgentDesignerSession } from '@/store/agent-designer-session';

interface AgentDesignerSessionModalProps {
  project: Project;
  events: WsEnvelope[];
}

type SessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

type Bubble =
  | { kind: 'user'; text: string; key: string }
  | { kind: 'assistant'; text: string; key: string };

export function AgentDesignerSessionModal({
  project,
  events,
}: AgentDesignerSessionModalProps) {
  // Store flips `open` to true when the auto-open hook detects an
  // agent-designer session starting. Closing (manual or auto on
  // pc_create_agent) flips it back.
  const open = useAgentDesignerSession((s) => s.runId !== null);
  const setRunId = useAgentDesignerSession((s) => s.setRunId);
  const clear = useAgentDesignerSession((s) => s.clear);

  // Detect the start of an agent-designer session from the WS stream. The
  // server sets `state: 'spawning'` first, then 'ready'. Either trips us.
  // We use a synthetic runId per project + per session-start since the
  // session itself doesn't have a public id — the store just needs a
  // truthy value to render the modal.
  const lastStateAtRef = useRef<string | null>(null);
  useEffect(() => {
    for (const env of events) {
      if (!env || env.type !== 'agent-designer-state') continue;
      const stateEnv = env as WsEnvelope & { state?: string };
      const seenKey = `${stateEnv.state ?? ''}:${(stateEnv as { ts?: number }).ts ?? ''}`;
      if (seenKey === lastStateAtRef.current) continue;
      lastStateAtRef.current = seenKey;
      if (stateEnv.state && stateEnv.state !== 'exited') {
        setRunId(`agent-designer:${project.id}`);
      }
    }
  }, [events, project.id, setRunId]);

  // Auto-close on pc_create_agent (project-agents-changed / pod-changed
  // event with change=created). The user can also close manually.
  useEffect(() => {
    if (!open) return;
    for (const env of events) {
      if (!env) continue;
      if (env.type === 'project-agents-changed') {
        clear();
        return;
      }
      if (
        env.type === 'pod-changed' &&
        (env as { change?: string }).change === 'created'
      ) {
        clear();
        return;
      }
    }
  }, [events, open, clear]);

  if (!open) return null;
  return <Chat project={project} events={events} onClose={clear} />;
}

function Chat({
  project,
  events,
  onClose,
}: {
  project: Project;
  events: WsEnvelope[];
  onClose: () => void;
}) {
  const [state, setState] = useState<SessionState>('spawning');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Tracks how many WS envelopes we've consumed so we re-scan only new
  // ones. Snap to events.length on mount so pre-mount envelopes from
  // concurrent orchestrator activity don't re-process.
  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  useEffect(() => {
    processedRef.current = eventsRef.current.length;
    // Best-effort cleanup on close: server tears down the PtySession +
    // cleans up the materialised pod files.
    return () => {
      void api.stopAgentDesigner(project.id).catch(() => {
        /* best-effort */
      });
    };
  }, [project.id]);

  // Bubbles + state derived from the live WS stream.
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  // Warmup pair (user "Reply with only the word OK." + assistant "OK") is
  // skipped — the spawn-time MCP-race fix from Section 20.C inserts a
  // synthetic turn pair that's plumbing, not conversation.
  const skipNextAssistantRef = useRef(false);

  useEffect(() => {
    const start =
      events.length >= processedRef.current ? processedRef.current : 0;
    const end = events.length;
    processedRef.current = end;
    let stateChanged: SessionState | null = null;
    const newBubbles: Bubble[] = [];
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env) continue;
      if (env.type === 'agent-designer-state') {
        const s = (env as { state?: string }).state;
        if (s === 'spawning' || s === 'ready' || s === 'thinking' || s === 'exited') {
          stateChanged = s;
        }
      } else if (env.type === 'agent-designer-jsonl') {
        const ev = (env as { event?: JsonlEvent }).event;
        if (!ev) continue;
        if (ev.kind === 'jsonl-user' && ev.text && ev.text.trim()) {
          if (isWarmupUserText(ev.text)) {
            skipNextAssistantRef.current = true;
            continue;
          }
          newBubbles.push({
            kind: 'user',
            text: ev.text,
            key: `u-${i}`,
          });
        } else if (
          ev.kind === 'jsonl-turn-end' &&
          ev.text &&
          ev.text.trim() &&
          (ev.stopReason === undefined ||
            ev.stopReason === null ||
            ev.stopReason === 'end_turn' ||
            ev.stopReason === 'max_tokens')
        ) {
          if (skipNextAssistantRef.current) {
            skipNextAssistantRef.current = false;
            continue;
          }
          newBubbles.push({
            kind: 'assistant',
            text: ev.text,
            key: `a-${i}`,
          });
        }
      } else if (env.type === 'agent-designer-exit') {
        stateChanged = 'exited';
      }
    }
    if (newBubbles.length > 0) {
      setBubbles((prev) => [...prev, ...newBubbles]);
    }
    if (stateChanged) {
      setState(stateChanged);
    }
  }, [events]);

  // Auto-scroll on new bubbles.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles.length, state]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || state === 'spawning' || state === 'exited') return;
    setDraft('');
    setError(null);
    // Optimistic user bubble — the JSONL stream eventually rebroadcasts
    // it but seeing it land instantly matches the orchestrator chat UX.
    setBubbles((prev) => [
      ...prev,
      { kind: 'user', text, key: `local-u-${Date.now()}` },
    ]);
    try {
      await api.sendAgentDesigner(project.id, text);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleInterrupt() {
    try {
      await api.interruptAgentDesigner(project.id);
    } catch {
      /* best-effort */
    }
  }

  const canSend =
    draft.trim().length > 0 && state !== 'spawning' && state !== 'exited';
  const statusLabel = useMemo<string>(() => {
    if (error) return error;
    if (state === 'spawning') return 'Starting…';
    if (state === 'thinking') return 'Thinking…';
    if (state === 'exited') return 'Session ended';
    return 'Ready';
  }, [state, error]);

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Agent designer session"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[80vh] w-full max-w-3xl flex-col border border-border bg-card text-sm shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Designing a new agent
            </div>
            <div className="flex items-baseline gap-2">
              <div className="truncate text-sm font-semibold text-foreground">
                agent-designer
              </div>
              <span className="shrink-0 bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {statusLabel}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Chat with agent-designer to design a new pod. Modal closes
              automatically when the pod is created. Close manually any time.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close session"
            className="shrink-0 border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            ✕ Close
          </button>
        </header>

        <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {bubbles.length === 0 && state === 'spawning' && (
            <p className="text-xs italic text-muted-foreground">
              Starting agent-designer…
            </p>
          )}
          {bubbles.length === 0 && state !== 'spawning' && (
            <p className="text-xs italic text-muted-foreground">
              Waiting for agent-designer's first message…
            </p>
          )}
          {bubbles.map((b) => (
            <BubbleRow key={b.key} bubble={b} />
          ))}
          {state === 'thinking' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 animate-pulse bg-muted-foreground/60" />
              Thinking…
            </div>
          )}
        </div>

        <footer className="border-t border-border bg-muted/20 p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={
                state === 'spawning'
                  ? 'Waiting for session to start…'
                  : state === 'exited'
                    ? 'Session ended. Close to dismiss.'
                    : 'Type your reply. Enter sends, Shift+Enter for a newline.'
              }
              rows={3}
              disabled={state === 'spawning' || state === 'exited'}
              className="flex-1 resize-none border border-border bg-background p-2 font-sans text-xs outline-none focus:border-primary disabled:opacity-50"
            />
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleSend()}
                disabled={!canSend}
                className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Send
              </button>
              <button
                onClick={() => void handleInterrupt()}
                disabled={state !== 'thinking'}
                className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              >
                Stop
              </button>
            </div>
          </div>
          {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
        </footer>
      </div>
    </div>
  );
}

function BubbleRow({ bubble }: { bubble: Bubble }) {
  if (bubble.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words border border-border bg-primary/30 px-3 py-2 text-xs">
          {bubble.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] border border-border bg-background px-3 py-2 text-xs">
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {bubble.text}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

/** Match the warmup turn's user prompt
 *  (apps/server/src/services/agent-run-manager.ts:DEFAULT_WARMUP_PROMPT).
 *  If the warmup prompt ever changes, update this matcher too. */
function isWarmupUserText(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed === 'reply with only the word ok.' ||
    trimmed === 'reply with only the word ok' ||
    trimmed.startsWith('reply with only the word ok')
  );
}
