// Section 32.5 — breadcrumb-mounted dropdown for switching between recent
// sessions of the active project. The trigger lives in App.tsx (the session
// label in the slim header). Click → fetches the project's sessions and
// renders them; click a row → resumes that session and closes the dropdown;
// "browse all" → flips the left rail into Sessions mode (existing 5++
// surface) without leaving the orchestrator tab.
//
// Read pattern mirrors SessionsRail (api.listSessions + api.resumeSession),
// trimmed for the dropdown footprint (no per-row Resume button — clicking
// the row IS the action; no per-row hover state since the dropdown is
// already a focused affordance).

import { useEffect, useRef, useState } from 'react';

import { api, type OrchestratorSession, type SessionTransitionResponse } from '@/api/client';
import { useRailMode } from '@/store/rail-mode';
import { useViewingSession } from '@/store/viewing-session';

interface SessionSwitcherProps {
  projectId: string;
  projectSlug: string;
  activeSessionId: string | null;
  /** Anchor element (the breadcrumb button) — used to position the dropdown
   *  flush-left under it. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
  applySessionTransition: (transition: SessionTransitionResponse) => void;
}

export function SessionSwitcher({
  projectId,
  projectSlug,
  activeSessionId,
  anchorEl,
  onClose,
  applySessionTransition,
}: SessionSwitcherProps) {
  const [sessions, setSessions] = useState<OrchestratorSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const setRailMode = useRailMode((s) => s.setMode);
  const setViewing = useViewingSession((s) => s.setViewing);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Fetch on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .listSessions(projectId)
      .then((rows) => {
        if (!cancelled) {
          setSessions(rows);
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setErr(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Click-outside + escape close.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose]);

  // Position flush-left under the anchor.
  const rect = anchorEl?.getBoundingClientRect();
  const style: React.CSSProperties = rect
    ? { position: 'fixed', top: rect.bottom + 4, left: rect.left, zIndex: 50 }
    : { display: 'none' };

  async function handleResume(targetId: string) {
    if (targetId === activeSessionId) {
      onClose();
      return;
    }
    if (resumingId) return;
    setResumingId(targetId);
    try {
      const transition = await api.resumeSession(projectId, targetId);
      applySessionTransition(transition);
      setViewing(projectSlug, null);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setResumingId(null);
    }
  }

  return (
    <div
      ref={panelRef}
      role="menu"
      style={style}
      className="min-w-[280px] max-w-[420px] border border-primary/40 bg-popover text-popover-foreground shadow-2xl"
    >
      <div className="border-b border-border px-3 py-1.5 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
        recent sessions
      </div>
      <div className="max-h-[360px] overflow-y-auto">
        {loading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
        )}
        {err && (
          <div className="px-3 py-2 text-xs text-destructive">Error: {err}</div>
        )}
        {!loading && !err && sessions.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No sessions yet.
          </div>
        )}
        {sessions.slice(0, 12).map((s) => {
          const isActive = s.id === activeSessionId;
          const title = s.title?.trim() || 'Untitled session';
          const when = formatStarted(s.startedAt);
          const isResuming = resumingId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => void handleResume(s.id)}
              disabled={resumingId !== null && !isResuming}
              className={`block w-full border-l-2 px-3 py-1.5 text-left text-xs hover:bg-muted ${
                isActive
                  ? 'border-primary bg-muted/40 text-primary'
                  : 'border-transparent text-foreground/90'
              }`}
            >
              <div className="flex items-center gap-2">
                {isActive && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                    title="live"
                  />
                )}
                <span className="truncate">{title}</span>
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {when}
                {isActive && ' · live'}
                {isResuming && ' · resuming…'}
              </div>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-testid="session-switcher-browse-all"
        onClick={() => {
          setRailMode('sessions');
          onClose();
        }}
        className="block w-full border-t border-border px-3 py-1.5 text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:bg-muted hover:text-accent"
      >
        browse all sessions →
      </button>
    </div>
  );
}

function formatStarted(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return (
    d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  );
}
