// 17b.11d — Dedicated design surface for the agent-designer pod.
//
// Opens automatically when the orchestrator dispatches agent-designer (the
// auto-open hook + zustand store drive this). Shows a focused conversation
// view (user + assistant turns only — no tool-call debug rows), plus an
// input affordance when the agent pauses with pc_ask_user / pc_ask_
// orchestrator. Submits answers via the existing pending-asks/answer route.
//
// Server-side, agent-designer's channel push to the orchestrator is
// suppressed (17b.11a), so this modal is the ONLY surface where the
// agent-designer's questions appear. The orchestrator chat stays clean.
//
// Closes automatically on terminal status (completed/failed/cancelled) via
// the auto-open effect. Explicit Close button is also available — closing
// mid-conversation doesn't kill the agent; the run keeps going. Reopening
// requires another agent-designer dispatch.
//
// Backfill: no replay on mount today. Events received before the modal
// opened don't appear. Pause is fetched via list endpoint on first
// pending-ask-changed receipt OR on initial mount-time scan.

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { AgentRunRecord, PendingAsk, Project } from '@/api/client';
import { api } from '@/api/client';
import type { JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';
import { useAgentDesignerSession } from '@/store/agent-designer-session';

interface AgentDesignerSessionModalProps {
  project: Project;
  events: WsEnvelope[];
}

interface AgentJsonlEnvelope extends WsEnvelope {
  type: 'agent-jsonl-event';
  runId: string;
  event: JsonlEvent;
}

interface AgentRunChangedEnvelope extends WsEnvelope {
  type: 'agent-run-changed';
  record: AgentRunRecord;
}

interface PendingAskChangedEnvelope extends WsEnvelope {
  type: 'pending-ask-changed';
  change: 'created' | 'answered' | 'cancelled';
  pendingAsk?: PendingAsk;
  pendingAskId?: string;
  runId?: string | null;
}

type Bubble =
  | { kind: 'user'; text: string; key: string }
  | { kind: 'assistant'; text: string; key: string };

export function AgentDesignerSessionModal({
  project,
  events,
}: AgentDesignerSessionModalProps) {
  const runId = useAgentDesignerSession((s) => s.runId);
  const clear = useAgentDesignerSession((s) => s.clear);
  if (!runId) return null;
  return (
    <Modal
      key={runId}
      runId={runId}
      project={project}
      events={events}
      onClose={clear}
    />
  );
}

function Modal({
  runId,
  project,
  events,
  onClose,
}: {
  runId: string;
  project: Project;
  events: WsEnvelope[];
  onClose: () => void;
}) {
  // Latest snapshot of this run, derived from the WS event stream (walks
  // backward to find the most-recent `agent-run-changed` for this runId).
  const run = useMemo<AgentRunRecord | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i];
      if (!env || env.type !== 'agent-run-changed') continue;
      const rec = (env as AgentRunChangedEnvelope).record;
      if (rec && rec.runId === runId) return rec;
    }
    return null;
  }, [events, runId]);

  // Bubbles from the JSONL stream — user + assistant turns only. Drops the
  // server-side warmup turn pair (spawn-time MCP-race fix from Section 20.C):
  //   user:      "Reply with only the word OK."
  //   assistant: "OK" (or similar short ack)
  // The warmup is internal plumbing; users shouldn't see it.
  const bubbles = useMemo<Bubble[]>(() => {
    const out: Bubble[] = [];
    let userIdx = 0;
    let assistantIdx = 0;
    let pendingWarmupSkip = false;
    for (const env of events) {
      if (!env || env.type !== 'agent-jsonl-event') continue;
      const j = env as AgentJsonlEnvelope;
      if (j.runId !== runId) continue;
      const ev = j.event;
      if (ev.kind === 'jsonl-user' && ev.text && ev.text.trim()) {
        if (isWarmupUserText(ev.text)) {
          pendingWarmupSkip = true; // skip this user bubble AND the next assistant
          continue;
        }
        out.push({ kind: 'user', text: ev.text, key: `u-${userIdx++}` });
      } else if (
        ev.kind === 'jsonl-turn-end' &&
        ev.text &&
        ev.text.trim() &&
        (ev.stopReason === undefined ||
          ev.stopReason === null ||
          ev.stopReason === 'end_turn' ||
          ev.stopReason === 'max_tokens')
      ) {
        if (pendingWarmupSkip) {
          pendingWarmupSkip = false;
          continue;
        }
        out.push({ kind: 'assistant', text: ev.text, key: `a-${assistantIdx++}` });
      }
    }
    return out;
  }, [events, runId]);

  // Auto-scroll on new bubbles.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles.length]);

  // Pending-ask state. Initial pull from list endpoint covers "modal opened
  // onto an already-paused run." `pending-ask-changed` envelopes keep it
  // synced from there.
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const lastPaProcessedRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void api
      .listAgentPendingAsks(project.id)
      .then((rows) => {
        if (cancelled) return;
        const match = rows.find((r) => r.runId === runId);
        setPendingAsk(match ?? null);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, runId]);

  useEffect(() => {
    const start =
      events.length >= lastPaProcessedRef.current ? lastPaProcessedRef.current : 0;
    const end = events.length;
    lastPaProcessedRef.current = end;
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env || env.type !== 'pending-ask-changed') continue;
      const pa = env as PendingAskChangedEnvelope;
      if (pa.change === 'created' && pa.pendingAsk && pa.pendingAsk.runId === runId) {
        setPendingAsk(pa.pendingAsk);
      } else if (
        (pa.change === 'answered' || pa.change === 'cancelled') &&
        pa.runId === runId
      ) {
        setPendingAsk(null);
      }
    }
  }, [events, runId]);

  // Answer-submit state.
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(answer: string) {
    if (!pendingAsk) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.answerAgentPendingAsk(
        project.id,
        pendingAsk.id,
        answer,
        'user',
      );
      if (!res.ok) {
        setSubmitError(res.cause ?? 'answer rejected');
        return;
      }
      setDraft('');
      // The WS `pending-ask-changed` event will clear pendingAsk locally —
      // no need to setPendingAsk(null) here.
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const status = run?.status ?? 'spawning';
  const statusPillClasses =
    status === 'paused'
      ? 'bg-warning/25 text-warning'
      : status === 'spawning'
        ? 'bg-muted text-muted-foreground'
        : status === 'completed'
          ? 'bg-success/25 text-success'
          : status === 'failed' || status === 'cancelled'
            ? 'bg-destructive/25 text-destructive'
            : 'bg-primary/20 text-primary';

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
              <span
                className={`shrink-0 px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${statusPillClasses}`}
              >
                {status}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The designer asks questions; answer here. Closing doesn't cancel the
              dispatch.
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
          {bubbles.length === 0 && (
            <p className="text-xs italic text-muted-foreground">
              Starting up. The designer's first message lands here.
            </p>
          )}
          {bubbles.map((b) => (
            <BubbleRow key={b.key} bubble={b} />
          ))}
        </div>

        <footer className="border-t border-border bg-muted/20 p-3">
          {pendingAsk ? (
            <PendingAskInput
              pendingAsk={pendingAsk}
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={handleSubmit}
              submitting={submitting}
              error={submitError}
            />
          ) : (
            <div className="text-center text-xs italic text-muted-foreground">
              {status === 'completed'
                ? "Design complete. Check the Agents tab for your new pod."
                : status === 'failed' || status === 'cancelled'
                  ? `Session ${status}. Close to dismiss.`
                  : 'Waiting on the designer…'}
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}

/** Match the warmup turn's user prompt (apps/server/src/services/agent-run-
 *  manager.ts:DEFAULT_WARMUP_PROMPT). If the warmup prompt ever changes,
 *  update this matcher too. We match loosely (trim + lowercase contains) so
 *  minor whitespace drift doesn't unmask the warmup. */
function isWarmupUserText(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === 'reply with only the word ok.' ||
    trimmed === 'reply with only the word ok' ||
    trimmed.startsWith('reply with only the word ok');
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

function PendingAskInput({
  pendingAsk,
  draft,
  onDraftChange,
  onSubmit,
  submitting,
  error,
}: {
  pendingAsk: PendingAsk;
  draft: string;
  onDraftChange: (v: string) => void;
  onSubmit: (answer: string) => void;
  submitting: boolean;
  error: string | null;
}) {
  const hasOptions = pendingAsk.options && pendingAsk.options.length > 0;

  return (
    <div className="space-y-2">
      <div className="border-l-2 border-l-warning/60 pl-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Designer is asking
        </div>
        <div className="mt-0.5 whitespace-pre-wrap text-xs text-foreground">
          {pendingAsk.question}
        </div>
        {pendingAsk.context && (
          <div className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
            {pendingAsk.context}
          </div>
        )}
      </div>

      {hasOptions ? (
        <div className="flex flex-wrap gap-2">
          {pendingAsk.options!.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={submitting}
              onClick={() => onSubmit(opt.value)}
              className="border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                e.preventDefault();
                onSubmit(draft.trim());
              }
            }}
            placeholder="Your answer… (Enter sends, Shift+Enter for newline)"
            rows={2}
            disabled={submitting}
            className="flex-1 resize-none border border-border bg-background p-2 font-sans text-xs outline-none focus:border-primary disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => onSubmit(draft.trim())}
            disabled={submitting || !draft.trim()}
            className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}

      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
