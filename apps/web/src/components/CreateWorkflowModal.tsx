// 4b.4 — Conversational "Create Workflow" modal.
//
// Mirrors CreateAgentModal.tsx's chat surface (spawning + bubble list +
// composer + WS-envelope routing) and adds a wider layout with a
// react-resizable-panels splitter: chat on the left (~40%), live workflow
// graph (B2 = 4b.5 + 4b.6) on the right (~60%). The graph re-renders
// whenever the interview pushes a `pc_update_workflow_draft`.
//
// WS envelope contract (mirrors agent-creator + adds the draft envelope):
//   workflow-creator-state  — session lifecycle
//   workflow-creator-event  — { event: { kind: 'user'|'assistant', text, ts } }
//   workflow-creator-exit   — session ended
//   workflow-creator-draft  — { sessionId, def } — pushed by the server when
//                             the model calls pc_update_workflow_draft
//   project-workflows-changed — committed; close the modal so the new entry
//                               shows up in WorkflowList
//
// Draft envelopes are filtered by sessionId so a stray broadcast from a stale
// session can't bleed into the live modal.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { api } from '@/api/client';
import type { Workflow } from '@/api/client';
import type { WsEnvelope, WsOutbound } from '@/hooks/use-project-ws';
import { AskCard } from './AskCard';
import { WorkflowGraph } from './WorkflowGraph';

interface CreateWorkflowModalProps {
  projectId: string;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
  onClose: () => void;
}

type Bubble =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant'; text: string; ts: number };

interface AskItem {
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  ts: number;
}

/** Flat list rendered in the chat column. Bubbles and asks share a single
 *  list so the picker shows up exactly where the model raised it. */
type Item =
  | { kind: 'bubble'; bubble: Bubble }
  | { kind: 'ask'; ask: AskItem };

type SessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

export function CreateWorkflowModal({ projectId, events, send, onClose }: CreateWorkflowModalProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [answeredAsks, setAnsweredAsks] = useState<Record<string, string>>({});
  const [state, setState] = useState<SessionState>('spawning');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draftDef, setDraftDef] = useState<Workflow | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Snap consumed-envelope count to events.length on mount so we skip
  // pre-modal envelopes from concurrent orchestrator activity. Hoisted above
  // the boot effect for the same reason as CreateAgentModal.
  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setAnsweredAsks({});
    setState('spawning');
    setError(null);
    setSessionId(null);
    setDraftDef(null);
    processedRef.current = eventsRef.current.length;
    api
      .startWorkflowCreator(projectId)
      .then((r) => {
        if (cancelled) return;
        // DON'T overwrite state from the response. r.state is always the
        // synchronous snapshot ('spawning') taken at endpoint-return, while
        // the WS `workflow-creator-state` envelope can arrive BEFORE this
        // .then() resolves with the real 'ready' transition. Setting state
        // here would clobber the WS-driven 'ready' back to 'spawning' and
        // leave the modal stuck on "Starting…" forever. WS is authoritative.
        setSessionId(r.sessionId);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      void api.stopWorkflowCreator(projectId).catch(() => {
        /* best-effort cleanup */
      });
    };
  }, [projectId]);

  // Walk every new envelope since last render — mirrors CreateAgentModal's
  // pattern. `workflow-creator-draft` and `ask` envelopes are filtered to this
  // session so a stale broadcast (or the orchestrator's own asks) can't
  // poison the modal.
  useEffect(() => {
    const start = events.length >= processedRef.current ? processedRef.current : 0;
    const end = events.length;
    processedRef.current = end;
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env) continue;
      if (env.type === 'workflow-creator-state') {
        const s = (env as { state?: string }).state;
        if (s) setState(s as SessionState);
      } else if (env.type === 'workflow-creator-event') {
        const ev = (env as { event?: { kind?: string; text?: string; ts?: string } }).event;
        if (!ev) continue;
        const ts = ev.ts ? Date.parse(ev.ts) : Date.now();
        if (ev.kind === 'user' && typeof ev.text === 'string') {
          appendBubble({ kind: 'user', text: ev.text, ts });
        } else if (ev.kind === 'assistant' && typeof ev.text === 'string' && ev.text.trim()) {
          appendBubble({ kind: 'assistant', text: ev.text, ts });
        }
      } else if (env.type === 'workflow-creator-exit') {
        setState('exited');
      } else if (env.type === 'workflow-creator-draft') {
        const d = env as { sessionId?: string; def?: Workflow };
        // Filter by sessionId — drop drafts from any other session that might
        // still be broadcasting on this project's WS.
        if (sessionId && d.sessionId && d.sessionId !== sessionId) continue;
        if (d.def && typeof d.def === 'object') setDraftDef(d.def);
      } else if (env.type === 'ask') {
        // Hooks forward `sessionId` (PC_SESSION_ID env) alongside the ask
        // payload. Drop asks whose sessionId doesn't match ours — they belong
        // to the orchestrator or another transient session.
        const a = env as {
          sessionId?: string | null;
          toolName?: string;
          toolUseId?: string;
          toolInput?: unknown;
        };
        if (!sessionId || a.sessionId !== sessionId) continue;
        if (!a.toolName || !a.toolUseId) continue;
        appendAsk({ toolName: a.toolName, toolUseId: a.toolUseId, toolInput: a.toolInput, ts: Date.now() });
      } else if (env.type === 'project-workflows-changed') {
        // pc_create_workflow committed → close so WorkflowList refreshes.
        closeRef.current();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, sessionId]);

  function appendBubble(b: Bubble) {
    setItems((prev) => {
      if (
        prev.some(
          (p) => p.kind === 'bubble' && p.bubble.kind === b.kind && p.bubble.text === b.text && p.bubble.ts === b.ts,
        )
      ) {
        return prev;
      }
      return [...prev, { kind: 'bubble', bubble: b }];
    });
  }

  function appendAsk(a: AskItem) {
    setItems((prev) => {
      if (prev.some((p) => p.kind === 'ask' && p.ask.toolUseId === a.toolUseId)) return prev;
      return [...prev, { kind: 'ask', ask: a }];
    });
  }

  function replyToAsk(toolUseId: string, answer: string) {
    if (send({ type: 'ask-reply', toolUseId, answer })) {
      setAnsweredAsks((prev) => ({ ...prev, [toolUseId]: answer }));
    }
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || state === 'spawning' || state === 'exited') return;
    setDraft('');
    setError(null);
    try {
      await api.sendWorkflowCreator(projectId, text);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleInterrupt() {
    try {
      await api.interruptWorkflowCreator(projectId);
    } catch {
      /* best-effort */
    }
  }

  const canSend = draft.trim().length > 0 && state !== 'spawning' && state !== 'exited';
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[85vh] w-full max-w-6xl flex-col border border-border bg-card text-sm shadow-xl">
        <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide">Create workflow</h2>
            <p className="text-xs text-muted-foreground">
              Interview drives a complete workflow. The visualizer updates as the draft forms. Close to cancel.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{statusLabel}</span>
            <button
              onClick={() => closeRef.current()}
              className="border border-border px-2 py-1 text-xs hover:bg-muted"
            >
              Close
            </button>
          </div>
        </header>

        <Group orientation="horizontal" id="pc-create-workflow-split" className="flex-1 min-h-0">
          <Panel id="chat" defaultSize="40%" minSize="28%">
            <div className="flex h-full flex-col">
              <BubbleList
                items={items}
                thinking={state === 'thinking'}
                answeredAsks={answeredAsks}
                onAskReply={replyToAsk}
              />
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
                        : 'Describe the workflow you want. Enter sends, Shift+Enter for a newline.'
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
              </footer>
            </div>
          </Panel>
          <Separator className="w-px bg-border transition-colors hover:bg-primary" />
          <Panel id="graph" defaultSize="60%" minSize="32%">
            <WorkflowGraph workflow={draftDef} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function BubbleList({
  items,
  thinking,
  answeredAsks,
  onAskReply,
}: {
  items: Item[];
  thinking: boolean;
  answeredAsks: Record<string, string>;
  onAskReply: (toolUseId: string, answer: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, thinking]);

  return (
    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
      {items.length === 0 && !thinking && (
        <p className="text-xs italic text-muted-foreground">
          Tell the workflow-creator what you want this workflow to do. It will interview you, draft the workflow, and commit when you confirm.
        </p>
      )}
      {items.map((item, i) => {
        if (item.kind === 'bubble') {
          return <BubbleRow key={`bubble-${item.bubble.ts}-${i}`} bubble={item.bubble} />;
        }
        const a = item.ask;
        return (
          <AskCard
            key={`ask-${a.toolUseId}`}
            toolName={a.toolName}
            toolUseId={a.toolUseId}
            toolInput={a.toolInput}
            answered={answeredAsks[a.toolUseId]}
            onReply={(answer) => onAskReply(a.toolUseId, answer)}
          />
        );
      })}
      {thinking && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 animate-pulse bg-muted-foreground/60" />
          Thinking…
        </div>
      )}
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
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{bubble.text}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

