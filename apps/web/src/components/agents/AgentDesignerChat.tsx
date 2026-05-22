// Extracted from AgentDesignerSessionModal.tsx — same chat lifecycle (spawn
// state pill + bubbles + composer + interrupt + best-effort cleanup), but
// stripped of the orchestrator-driven auto-pop logic so it can be embedded
// inside the Conversational tab of CreatePodModal. Parent must have already
// fired api.startAgentDesigner before mounting this; Chat just renders the
// WS-driven state + sends user messages over the existing HTTP routes.

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { api, type Project } from '@/api/client';
import type { JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';

export type AgentDesignerState = 'spawning' | 'ready' | 'thinking' | 'exited';

type Bubble =
  | { kind: 'user'; text: string; key: string }
  | { kind: 'assistant'; text: string; key: string };

interface AgentDesignerChatProps {
  project: Project;
  events: WsEnvelope[];
}

export function AgentDesignerChat({ project, events }: AgentDesignerChatProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Mount may land AFTER the spawn already broadcast 'spawning' → 'ready'
  // (HTTP start kicked off before this component mounted). Backfill state +
  // bubbles by scanning history at mount, then the live effect appends from
  // there. Skips the warmup turn pair (synthetic prompt from Section 20.C).
  const initialFromHistory = useMemo<{
    state: AgentDesignerState;
    bubbles: Bubble[];
  }>(() => {
    let state: AgentDesignerState = 'spawning';
    const bubbles: Bubble[] = [];
    let skipNextAssistant = false;
    for (let i = 0; i < events.length; i++) {
      const env = events[i];
      if (!env) continue;
      if (env.type === 'agent-designer-state') {
        const s = (env as { state?: string }).state;
        if (s === 'spawning' || s === 'ready' || s === 'thinking' || s === 'exited') {
          state = s;
        }
      } else if (env.type === 'agent-designer-jsonl') {
        const ev = (env as { event?: JsonlEvent }).event;
        if (!ev) continue;
        if (ev.kind === 'jsonl-user' && ev.text && ev.text.trim()) {
          if (isWarmupUserText(ev.text)) {
            skipNextAssistant = true;
            continue;
          }
          bubbles.push({ kind: 'user', text: ev.text, key: `u-${i}` });
        } else if (
          ev.kind === 'jsonl-turn-end' &&
          ev.text &&
          ev.text.trim() &&
          (ev.stopReason === undefined ||
            ev.stopReason === null ||
            ev.stopReason === 'end_turn' ||
            ev.stopReason === 'max_tokens')
        ) {
          if (skipNextAssistant) {
            skipNextAssistant = false;
            continue;
          }
          bubbles.push({ kind: 'assistant', text: ev.text, key: `a-${i}` });
        }
      } else if (env.type === 'agent-designer-exit') {
        state = 'exited';
      }
    }
    return { state, bubbles };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [state, setState] = useState<AgentDesignerState>(initialFromHistory.state);
  const [bubbles, setBubbles] = useState<Bubble[]>(initialFromHistory.bubbles);

  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  useEffect(() => {
    processedRef.current = eventsRef.current.length;
    // No cleanup that calls api.stopAgentDesigner — React 18 Strict Mode
    // double-invokes mount/cleanup cycles in dev, which would kill the
    // freshly-spawned claude.exe within ~50ms of POST /start (giving us
    // 16-byte silent transcripts). Modal-close is the canonical teardown
    // path; CreatePodModal wires it explicitly into its close handler.
  }, [project.id]);

  const skipNextAssistantRef = useRef(false);

  useEffect(() => {
    const start =
      events.length >= processedRef.current ? processedRef.current : 0;
    const end = events.length;
    processedRef.current = end;
    let stateChanged: AgentDesignerState | null = null;
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
          newBubbles.push({ kind: 'user', text: ev.text, key: `u-${i}` });
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
          newBubbles.push({ kind: 'assistant', text: ev.text, key: `a-${i}` });
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
    // No optimistic bubble — the JSONL stream is the single source of truth
    // for user messages. The orchestrator chat works the same way; adding an
    // optimistic bubble here doubles up when the jsonl-user envelope arrives.
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          agent-designer
        </span>
        <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {statusLabel}
        </span>
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {bubbles.length === 0 && state === 'spawning' && (
          <p className="text-xs italic text-muted-foreground">
            Starting agent-designer…
          </p>
        )}
        {bubbles.length === 0 && state !== 'spawning' && state !== 'exited' && (
          <p className="text-xs italic text-muted-foreground">
            Ready. Type below to start the conversation.
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

      <div className="border-t border-border bg-muted/20 p-3">
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
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => void handleInterrupt()}
              disabled={state !== 'thinking'}
              className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              Stop
            </button>
          </div>
        </div>
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
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
 *  (apps/server/src/services/agent-run-manager.ts:DEFAULT_WARMUP_PROMPT). */
function isWarmupUserText(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed === 'reply with only the word ok.' ||
    trimmed === 'reply with only the word ok' ||
    trimmed.startsWith('reply with only the word ok')
  );
}
