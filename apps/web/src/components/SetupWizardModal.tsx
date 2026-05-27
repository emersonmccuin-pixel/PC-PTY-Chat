// 5.6 / D82 — Conversational setup wizard modal.
//
// Uses the same shared chat + xterm surface as the orchestrator and the other
// transient agent modals. The only setup-wizard-specific work here is adapting
// `setup-wizard-*` WS envelopes into ChatSurface's standard event/raw shapes.

import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/api/client';
import { TransientAgentConversation } from '@/components/TransientAgentConversation';
import type { JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';

interface SetupWizardModalProps {
  projectId: string;
  events: WsEnvelope[];
  onClose: () => void;
}

type SessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

interface AdapterResult {
  envelopes: WsEnvelope[];
  state: SessionState;
}

function adaptSetupWizardEvents(
  events: WsEnvelope[],
  projectId: string,
  sessionId: string | null,
  fallbackState: SessionState,
): AdapterResult {
  const out: WsEnvelope[] = [];
  let state = fallbackState;
  for (const env of events) {
    if (env.type === 'setup-wizard-state') {
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
    if (env.type === 'setup-wizard-jsonl') {
      if (!belongsToSession(env, sessionId)) continue;
      const ev = (env as { event?: JsonlEvent }).event;
      if (ev) out.push({ projectId, type: 'jsonl', sessionId, event: ev });
      continue;
    }
    if (env.type === 'setup-wizard-raw') {
      const rawSessionId = (env as { sessionId?: unknown }).sessionId;
      if (sessionId && rawSessionId === sessionId) {
        out.push({ ...env, projectId, type: 'raw', sessionId });
      }
      continue;
    }
    if (env.type === 'setup-wizard-exit') {
      if (!belongsToSession(env, sessionId)) continue;
      state = 'exited';
    }
  }
  return { envelopes: out, state };
}

function belongsToSession(env: WsEnvelope, sessionId: string | null): boolean {
  if (!sessionId) return true;
  return (env as { sessionId?: unknown }).sessionId === sessionId;
}

export function SetupWizardModal({ projectId, events, onClose }: SetupWizardModalProps) {
  const [state, setState] = useState<SessionState>('spawning');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let cancelled = false;
    setState('spawning');
    setSessionId(null);
    setError(null);
    processedRef.current = eventsRef.current.length;
    api
      .startSetupWizard(projectId)
      .then((r) => {
        if (cancelled) return;
        setSessionId(r.sessionId);
        setState(r.state as SessionState);
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
        if (!belongsToSession(env, sessionId)) continue;
        const s = (env as { state?: string }).state;
        if (s === 'spawning' || s === 'ready' || s === 'thinking' || s === 'exited') {
          setState(s);
        }
      } else if (env.type === 'setup-wizard-exit') {
        if (!belongsToSession(env, sessionId)) continue;
        setState('exited');
      } else if (env.type === 'project-claude-md-changed') {
        closeRef.current();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, sessionId]);

  const adapted = useMemo(
    () => adaptSetupWizardEvents(events, projectId, sessionId, state),
    [events, projectId, sessionId, state],
  );

  const statusLabel = useMemo<string>(() => {
    if (error) return error;
    if (adapted.state === 'spawning') return 'Starting...';
    if (adapted.state === 'thinking') return 'Thinking...';
    if (adapted.state === 'exited') return 'Session ended';
    return 'Ready';
  }, [adapted.state, error]);

  const emptyState =
    adapted.state === 'spawning'
      ? 'Starting setup-wizard...'
      : adapted.state === 'exited'
        ? 'Session ended.'
        : "Ready. Type below to answer the setup wizard.";

  const composerPlaceholder =
    adapted.state === 'spawning'
      ? 'Waiting for session to start...'
      : adapted.state === 'exited'
        ? 'Session ended. Close to dismiss.'
        : 'Answer the wizard. Enter sends, Shift+Enter for a newline.';

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[92vh] w-[96vw] max-w-[1600px] flex-col border border-border bg-card text-sm shadow-xl">
        <TransientAgentConversation
          events={adapted.envelopes}
          projectId={projectId}
          sessionId={sessionId}
          title={<span className="text-foreground">Project setup</span>}
          titleText="Project setup"
          subtitle="Quick interview that writes your project's CLAUDE.md. Close to cancel."
          statusLabel={statusLabel}
          onClose={() => closeRef.current()}
          onSend={(text) => {
            void api.sendSetupWizard(projectId, text).catch(() => {
              /* surfaced by state/error paths when available */
            });
            return true;
          }}
          onInterrupt={() => {
            void api.interruptSetupWizard(projectId).catch(() => {
              /* best-effort */
            });
            return true;
          }}
          onTerminalInput={(data) => {
            void api.sendSetupWizardTerminalInput(projectId, data).catch(() => {
              /* best-effort */
            });
            return true;
          }}
          onTerminalResize={(cols, rows) => {
            void api.resizeSetupWizard(projectId, cols, rows).catch(() => {
              /* best-effort */
            });
            return true;
          }}
          composerHistoryKey={`setup-wizard:${projectId}`}
          composerDisabled={adapted.state === 'spawning' || adapted.state === 'exited'}
          composerPlaceholder={composerPlaceholder}
          emptyState={emptyState}
        />
      </div>
    </div>
  );
}
