// 4b.4 — Conversational "Create Workflow" modal.
//
// Mirrors CreateAgentModal.tsx's chat surface (spawning + bubble list +
// composer + WS-envelope routing) and adds a wider layout with a
// react-resizable-panels splitter: chat on the left (~40%), graph placeholder
// on the right (~60%). Phase B1 leaves the right pane as a placeholder; the
// real WorkflowGraph (B2 = 4b.5 + 4b.6) drops into the same prop slot.
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
import type { WsEnvelope } from '@/hooks/use-project-ws';

interface CreateWorkflowModalProps {
  projectId: string;
  events: WsEnvelope[];
  onClose: () => void;
}

type Bubble =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant'; text: string; ts: number };

type SessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

/** Minimal shape we peek at for the placeholder preview in B1. The full
 *  Workflow type from @pc/domain lands in B2 when the visualizer renders.
 *  Web stays off @pc/domain deliberately ([3d session-log finding #2]). */
interface DraftPreview {
  id?: string;
  description?: string;
  triggers?: { on_enter?: { stage_id?: string }; callable?: boolean };
  nodes?: Array<{ id?: string; kind?: string }>;
}

export function CreateWorkflowModal({ projectId, events, onClose }: CreateWorkflowModalProps) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [state, setState] = useState<SessionState>('spawning');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draftDef, setDraftDef] = useState<DraftPreview | null>(null);
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
    setBubbles([]);
    setState('spawning');
    setError(null);
    setSessionId(null);
    setDraftDef(null);
    processedRef.current = eventsRef.current.length;
    api
      .startWorkflowCreator(projectId)
      .then((r) => {
        if (cancelled) return;
        setState(r.state as SessionState);
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
  // pattern. `workflow-creator-draft` envelopes are filtered to this session
  // so a stale broadcast can't poison the visualizer.
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
        const d = env as { sessionId?: string; def?: DraftPreview };
        // Filter by sessionId — drop drafts from any other session that might
        // still be broadcasting on this project's WS.
        if (sessionId && d.sessionId && d.sessionId !== sessionId) continue;
        if (d.def && typeof d.def === 'object') setDraftDef(d.def);
      } else if (env.type === 'project-workflows-changed') {
        // pc_create_workflow committed → close so WorkflowList refreshes.
        closeRef.current();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, sessionId]);

  function appendBubble(b: Bubble) {
    setBubbles((prev) => {
      if (prev.some((p) => p.kind === b.kind && p.text === b.text && p.ts === b.ts)) {
        return prev;
      }
      return [...prev, b];
    });
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
              <BubbleList bubbles={bubbles} thinking={state === 'thinking'} />
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
            <GraphPlaceholder draft={draftDef} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function BubbleList({ bubbles, thinking }: { bubbles: Bubble[]; thinking: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles, thinking]);

  return (
    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
      {bubbles.length === 0 && !thinking && (
        <p className="text-xs italic text-muted-foreground">
          Tell the workflow-creator what you want this workflow to do. It will interview you, draft the workflow, and commit when you confirm.
        </p>
      )}
      {bubbles.map((b, i) => (
        <BubbleRow key={`${b.ts}-${i}`} bubble={b} />
      ))}
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

// B1 placeholder. B2 (4b.5 + 4b.6) replaces this with the react-flow
// WorkflowGraph component that renders nodes + edges from `draft`. The text
// summary here is intentional proof-of-life for the draft envelope plumbing
// so self-testing the chat → draft path doesn't depend on the visualizer.
function GraphPlaceholder({ draft }: { draft: DraftPreview | null }) {
  if (!draft) {
    return (
      <div className="flex h-full items-center justify-center bg-background/40 p-6 text-center">
        <p className="max-w-sm text-xs italic text-muted-foreground">
          Draft will appear here as the interview progresses.
        </p>
      </div>
    );
  }
  const nodes = draft.nodes ?? [];
  const triggerSummary = (() => {
    const parts: string[] = [];
    const stageId = draft.triggers?.on_enter?.stage_id;
    if (stageId) parts.push(`on_enter ${stageId}`);
    if (draft.triggers?.callable) parts.push('callable');
    return parts.length > 0 ? parts.join(' · ') : '(no triggers)';
  })();
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-background/40 p-4">
      <div className="border border-border bg-card px-3 py-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Draft preview</div>
        <div className="mt-1 text-sm font-medium text-foreground">{draft.id ?? '(no id yet)'}</div>
        {draft.description && (
          <div className="mt-1 text-xs text-muted-foreground">{draft.description}</div>
        )}
        <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          {triggerSummary}
        </div>
      </div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        nodes ({nodes.length})
      </div>
      <div className="flex flex-col gap-1">
        {nodes.map((n, i) => (
          <div
            key={`${n.id ?? 'node'}-${i}`}
            className="flex items-center justify-between border border-border bg-card px-3 py-2 text-xs"
          >
            <span className="font-medium text-foreground">{n.id ?? `(node ${i + 1})`}</span>
            <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {n.kind ?? 'unknown'}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[10px] italic text-muted-foreground">
        Visualizer lands in 4b.5 — this placeholder is proof-of-life for the draft envelope plumbing.
      </p>
    </div>
  );
}
