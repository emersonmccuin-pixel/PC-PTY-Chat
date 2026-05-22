// Vendored from emersonmccuin-pixel/pc-pty-chat-rig @ legacy/app.js (MIT)
// Source: apps/web/legacy/app.js
// Adapted for Project Companion: thin wrapper around <ChatSurface> that owns
// session metadata (title / + New session / Resume / past-session view /
// session-ended banner) and the StatusBar. All chat rendering + composer +
// thinking-indicator + scroll machinery lives in ChatSurface.

import { useEffect, useMemo, useState } from 'react';

import { api, type OrchestratorSession, type Project } from '@/api/client';
import type {
  ChatEvent,
  JsonlEvent,
  WsEnvelope,
  WsOutbound,
  WsStatus,
} from '@/hooks/use-project-ws';
import { useViewingSession } from '@/store/viewing-session';
import { ChatSurface } from '@/components/ChatSurface';
import { StatusBar, type UsageTotals } from '@/components/StatusBar';

interface OrchestratorProps {
  project: Project;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
  clearWs: () => void;
  wsStatus: WsStatus;
}

export function Orchestrator({ project, events, send, clearWs, wsStatus }: OrchestratorProps) {
  // Viewing a past session? When set, the chat panel renders that session's
  // events.jsonl in read-only mode (composer hidden, "Return to live" button).
  const viewingSessionId = useViewingSession((s) => s.bySlug[project.slug] ?? null);
  const setViewing = useViewingSession((s) => s.setViewing);

  // Fetched events for the viewing-past-session case. Lives in component
  // state, refetched when viewingSessionId changes.
  const [pastEvents, setPastEvents] = useState<WsEnvelope[]>([]);
  const [pastLoading, setPastLoading] = useState(false);
  const [pastError, setPastError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewingSessionId) {
      setPastEvents([]);
      setPastError(null);
      return;
    }
    let cancelled = false;
    setPastLoading(true);
    setPastError(null);
    api
      .getSessionEvents(project.id, viewingSessionId)
      .then((raw) => {
        if (cancelled) return;
        const wrapped: WsEnvelope[] = raw.map((event) => ({
          projectId: project.id,
          type: 'event',
          event: event as Record<string, unknown>,
        }));
        setPastEvents(wrapped);
      })
      .catch((err: Error) => {
        if (!cancelled) setPastError(err.message);
      })
      .finally(() => {
        if (!cancelled) setPastLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewingSessionId, project.id]);

  // Active session. Fetched once per project, then patched live from WS
  // session-changed (new-session / resume) + session-title-updated.
  const [session, setSession] = useState<OrchestratorSession | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getActiveSession(project.id)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((err) => console.error('[pc] getActiveSession', err));
    return () => {
      cancelled = true;
    };
  }, [project.id]);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'session-changed' || e.type === 'session-title-updated') {
        setSession((e as WsEnvelope & { session: OrchestratorSession }).session);
        break;
      }
    }
  }, [events]);

  const sourceEvents = viewingSessionId ? pastEvents : events;
  const isViewingPast = viewingSessionId !== null;

  // Session token usage — sum jsonl-usage envelopes across the current stream.
  // Sidechain entries short-circuit at the tailer, so subagent tokens aren't
  // included here. Past-session view: jsonl-usage envelopes survive in
  // events.jsonl since 0e, so the bar still shows useful numbers.
  const sessionUsage = useMemo<UsageTotals>(() => {
    const totals: UsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    for (const env of events) {
      if (env.type !== 'jsonl') continue;
      const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
      if (!ev || ev.kind !== 'jsonl-usage') continue;
      totals.inputTokens += ev.inputTokens;
      totals.outputTokens += ev.outputTokens;
      totals.cacheCreationTokens += ev.cacheCreationTokens;
      totals.cacheReadTokens += ev.cacheReadTokens;
    }
    return totals;
  }, [events]);

  const liveModel = useMemo<string | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type !== 'jsonl') continue;
      const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
      if (ev?.kind === 'jsonl-usage' && ev.model) return ev.model;
    }
    return session?.model ?? null;
  }, [events, session?.model]);

  // session-end event from CC's SessionEnd hook. The PTY is gone; disable the
  // composer + surface a footer notice. Cleared when a fresh session is active.
  const sessionEnded = useMemo(() => {
    if (viewingSessionId) return false;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type !== 'event') continue;
      const ev = (env as WsEnvelope & { event: ChatEvent }).event;
      if (ev?.kind === 'session-end') return true;
      if (ev?.kind === 'user' || ev?.kind === 'assistant') return false;
    }
    return false;
  }, [events, viewingSessionId]);

  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  async function onResume() {
    if (!session?.id || resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      await api.resumeSession(project.id, session.id);
      setViewing(project.slug, null);
      setPastEvents([]);
      clearWs();
    } catch (err) {
      setResumeError((err as Error).message);
    } finally {
      setResuming(false);
    }
  }

  async function onNewSession() {
    if (!confirm('Start a new chat session? Current chat history will be cleared.')) return;
    try {
      await api.startNewSession(project.id);
      setViewing(project.slug, null);
      setPastEvents([]);
      clearWs();
    } catch (err) {
      alert(`Couldn't start a new session: ${(err as Error).message}`);
    }
  }

  const composerHidden = isViewingPast || sessionEnded;

  const headerSlot = (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
      <div className="min-w-0 flex-1 truncate text-sm">
        {isViewingPast ? (
          <span className="text-muted-foreground">
            Viewing past session <span className="text-foreground/80">(read-only)</span>
          </span>
        ) : session?.title ? (
          <span className="text-foreground" title={session.title}>
            {session.title}
          </span>
        ) : (
          <span className="italic text-muted-foreground">Untitled session</span>
        )}
      </div>
      {isViewingPast ? (
        <button
          onClick={() => setViewing(project.slug, null)}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Stop viewing this past session and return to the live chat"
        >
          ← Return to live
        </button>
      ) : (
        <button
          onClick={onNewSession}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title="End the current chat session and start a fresh one"
        >
          + New session
        </button>
      )}
    </div>
  );

  const bannerSlot = !isViewingPast && sessionEnded ? (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-warning/10 px-4 py-2 text-xs text-warning">
      <span>
        This session ended. Resume it, or click{' '}
        <span className="font-semibold">+ New session</span> above for a fresh chat.
      </span>
      <div className="flex items-center gap-2">
        {resumeError && (
          <span className="text-red-400">Couldn't resume: {resumeError}</span>
        )}
        <button
          onClick={onResume}
          disabled={resuming || !session?.id}
          title="Resume this conversation as the live chat"
          className="rounded border border-warning/40 bg-card px-3 py-1 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          {resuming ? 'Resuming…' : 'Resume session'}
        </button>
      </div>
    </div>
  ) : null;

  const footerSlot = (
    <StatusBar
      model={liveModel}
      usage={sessionUsage}
      projectId={project.id}
      wsStatus={wsStatus}
    />
  );

  const emptyState = pastLoading ? (
    'Loading session…'
  ) : pastError ? (
    <span className="text-red-400">Error loading session: {pastError}</span>
  ) : isViewingPast ? (
    'This session has no events on disk.'
  ) : (
    'No chat events yet. Send a message below to wake the orchestrator.'
  );

  return (
    <ChatSurface
      events={sourceEvents}
      projectId={project.id}
      currentSessionId={session?.id ?? null}
      onSend={(text) => send({ type: 'send', text })}
      onInterrupt={() => send({ type: 'interrupt' })}
      onAskReply={(toolUseId, answer) =>
        send({ type: 'ask-reply', toolUseId, answer })
      }
      composerHistoryKey={project.slug}
      composerHidden={composerHidden}
      headerSlot={headerSlot}
      bannerSlot={bannerSlot}
      footerSlot={footerSlot}
      emptyState={emptyState}
    />
  );
}
