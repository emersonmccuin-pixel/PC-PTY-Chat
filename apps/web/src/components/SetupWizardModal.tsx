// 5.6 / D82 — Conversational setup wizard modal.
//
// Cloned shape from CreateAgentModal. Spawns a transient PtySession layered
// with setup-wizard-prompt.md and renders a minimal chat surface. The
// setup-wizard prompt restricts the model to one tool call
// (`pc_write_claude_md`); when that fires, the server broadcasts
// `project-claude-md-changed`, the modal closes, and the Project Settings
// nag banner clears.
//
// WS events are routed via the parent project's WS connection — the modal
// reads the `events` prop and pulls only the `setup-wizard-*` envelopes.
// On close (manual or success), DELETE the server-side session.

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

interface SetupWizardModalProps {
  projectId: string;
  events: WsEnvelope[];
  onClose: () => void;
}

type Bubble =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant'; text: string; ts: number };

type SessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

export function SetupWizardModal({ projectId, events, onClose }: SetupWizardModalProps) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [state, setState] = useState<SessionState>('spawning');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let cancelled = false;
    setBubbles([]);
    setState('spawning');
    setError(null);
    processedRef.current = eventsRef.current.length;
    api
      .startSetupWizard(projectId)
      .then((s) => {
        if (!cancelled) setState(s as SessionState);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      void api.stopSetupWizard(projectId).catch(() => {
        /* best-effort cleanup */
      });
    };
  }, [projectId]);

  useEffect(() => {
    const start = events.length >= processedRef.current ? processedRef.current : 0;
    const end = events.length;
    processedRef.current = end;
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env) continue;
      if (env.type === 'setup-wizard-state') {
        const s = (env as { state?: string }).state;
        if (s) setState(s as SessionState);
      } else if (env.type === 'setup-wizard-event') {
        const ev = (env as { event?: { kind?: string; text?: string; ts?: string } }).event;
        if (!ev) continue;
        const ts = ev.ts ? Date.parse(ev.ts) : Date.now();
        if (ev.kind === 'user' && typeof ev.text === 'string') {
          appendBubble({ kind: 'user', text: ev.text, ts });
        } else if (ev.kind === 'assistant' && typeof ev.text === 'string' && ev.text.trim()) {
          appendBubble({ kind: 'assistant', text: ev.text, ts });
        }
      } else if (env.type === 'setup-wizard-exit') {
        setState('exited');
      } else if (env.type === 'project-claude-md-changed') {
        // Wizard wrote the file — close so the user sees the nag banner clear.
        closeRef.current();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

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
      await api.sendSetupWizard(projectId, text);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleInterrupt() {
    try {
      await api.interruptSetupWizard(projectId);
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
      <div className="flex h-[80vh] w-full max-w-3xl flex-col border border-border bg-card text-sm shadow-xl">
        <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide">Project setup</h2>
            <p className="text-xs text-muted-foreground">
              Quick interview that writes your project's CLAUDE.md. Close to cancel.
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
                  : 'Answer the wizard. Enter sends, Shift+Enter for a newline.'
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
          The setup wizard will ask a few questions about your project and write
          a CLAUDE.md when you confirm. It's short — should take a couple minutes.
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
