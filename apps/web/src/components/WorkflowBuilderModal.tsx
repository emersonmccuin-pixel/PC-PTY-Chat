// Section 19.10 — "+ New workflow" modal (v2-aware).
//
// Mirror of CreateWorkflowModal but for the v2 workflow-builder pod and
// WorkflowGraphV2 visualizer. Two-pane split: chat on the left (~40%), live
// authoring graph on the right (~60%). User can drag nodes + wire edges in the
// visualizer; those edits push back into the server-side draft store so the
// agent picks them up on its next turn (sync-model-A, Section 19 lock 8).
//
// WS envelope contract:
//   workflow-builder-state  — session lifecycle
//   workflow-builder-jsonl  — chat envelopes (consumed by WorkflowBuilderChat)
//   workflow-builder-exit   — session ended
//   workflow-builder-draft  — { sessionId, def } — pushed by the server when
//                             the model calls pc_save_workflow_draft
//   project-workflows-changed — committed; close the modal so WorkflowList
//                               refreshes.
//
// Edit mode: when `editingWorkflow` is supplied, the modal opens with the
// existing def pre-loaded into the visualizer + fires a `[edit-mode
// workflowId="…"]` handoff to the agent once the session reaches `ready`.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { WorkflowV2 } from '@pc/domain';

import { api } from '@/api/client';
import type { WsEnvelope, WsOutbound } from '@/hooks/use-project-ws';
import { WorkflowBuilderChat } from './WorkflowBuilderChat';
import { WorkflowGraphV2 } from './WorkflowGraphV2';

interface EditingWorkflowV2 {
  id: string;
  def: WorkflowV2.Workflow;
  yamlText?: string;
}

interface WorkflowBuilderModalProps {
  projectId: string;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
  onClose: () => void;
  /** When set, the modal opens in edit mode — pre-populated draft + edit-mode
   *  handoff sent on boot. */
  editingWorkflow?: EditingWorkflowV2;
}

type SessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

function buildEditHandoff(editing: EditingWorkflowV2): string {
  return [
    `[edit-mode workflowId="${editing.id}"]`,
    '',
    'Here is the current definition of the v2 workflow the user wants to edit:',
    '',
    '```json',
    JSON.stringify(editing.def, null, 2),
    '```',
    '',
    "Acknowledge in one short line that you've loaded it, then wait for the user to describe what they want to change. Don't restart the interview from scratch — they already authored this. Publish via pc_publish_workflow.",
  ].join('\n');
}

export function WorkflowBuilderModal({
  projectId,
  events,
  send,
  onClose,
  editingWorkflow,
}: WorkflowBuilderModalProps) {
  const isEditMode = Boolean(editingWorkflow);
  const [state, setState] = useState<SessionState>('spawning');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draftDef, setDraftDef] = useState<WorkflowV2.Workflow | null>(
    editingWorkflow?.def ?? null,
  );

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const handoffSentRef = useRef(false);
  const editingRef = useRef(editingWorkflow);
  editingRef.current = editingWorkflow;

  useEffect(() => {
    let cancelled = false;
    setState('spawning');
    setError(null);
    setSessionId(null);
    setDraftDef(editingRef.current?.def ?? null);
    handoffSentRef.current = false;
    processedRef.current = eventsRef.current.length;
    api
      .startWorkflowBuilder(projectId)
      .then((r) => {
        if (cancelled) return;
        // WS-driven state is authoritative — same pattern as v1 modal. Setting
        // state from the start response can clobber an already-arrived `ready`
        // envelope.
        setSessionId(r.sessionId);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      void api.stopWorkflowBuilder(projectId).catch(() => {
        /* best-effort cleanup */
      });
    };
  }, [projectId]);

  // Edit-mode handoff: fire once after the session reaches `ready`.
  useEffect(() => {
    if (!isEditMode) return;
    if (handoffSentRef.current) return;
    if (state !== 'ready') return;
    const editing = editingRef.current;
    if (!editing) return;
    handoffSentRef.current = true;
    const handoff = buildEditHandoff(editing);
    void api.sendWorkflowBuilder(projectId, handoff).catch((e: unknown) => {
      setError(`failed to send edit-mode handoff: ${(e as Error).message}`);
      handoffSentRef.current = false;
    });
  }, [state, isEditMode, projectId]);

  // Walk new envelopes since last render for the modal-owned concerns: session
  // state, the live draft (visualizer), and the publish signal (close).
  useEffect(() => {
    const start = events.length >= processedRef.current ? processedRef.current : 0;
    const end = events.length;
    processedRef.current = end;
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env) continue;
      if (env.type === 'workflow-builder-state') {
        const s = (env as { state?: string }).state;
        if (s) setState(s as SessionState);
      } else if (env.type === 'workflow-builder-exit') {
        setState('exited');
      } else if (env.type === 'workflow-builder-draft') {
        const d = env as { sessionId?: string; def?: WorkflowV2.Workflow };
        if (sessionId && d.sessionId && d.sessionId !== sessionId) continue;
        if (d.def && typeof d.def === 'object') {
          setDraftDef(d.def);
        }
      } else if (env.type === 'project-workflows-changed') {
        const change = env as { change?: string; id?: string };
        if (isEditMode && editingRef.current && change.id && change.id !== editingRef.current.id) {
          continue;
        }
        closeRef.current();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, sessionId]);

  // Push user drags / wires back into the server-side draft store so the
  // agent's next turn sees them. The WS broadcast that follows will re-set
  // `draftDef` to the same value (idempotent) — no infinite loop.
  function handleGraphChange(next: WorkflowV2.Workflow): void {
    setDraftDef(next);
    if (!sessionId) return;
    void api
      .saveWorkflowBuilderDraft(projectId, sessionId, next)
      .catch(() => {
        /* best-effort — agent picks up on next read */
      });
  }

  function replyToAsk(toolUseId: string, answer: string): boolean {
    return send({ type: 'ask-reply', toolUseId, answer });
  }

  const statusLabel = useMemo<string>(() => {
    if (error) return error;
    if (state === 'spawning') return 'Starting…';
    if (state === 'thinking') return 'Thinking…';
    if (state === 'exited') return 'Session ended';
    return 'Ready';
  }, [state, error]);

  const title = isEditMode ? `Edit workflow — ${editingWorkflow!.id}` : 'New workflow';
  const subtitle = isEditMode
    ? 'Tell the model what you want to change. Drag nodes to reposition.'
    : 'Interview drives a complete workflow. Drag nodes to reposition; sockets to wire. Close to cancel.';

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[85vh] w-full max-w-6xl flex-col border border-border bg-card text-sm shadow-xl">
        <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
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

        <Group orientation="horizontal" id="pc-workflow-builder-split" className="flex-1 min-h-0">
          <Panel id="chat" defaultSize="40%" minSize="28%">
            <WorkflowBuilderChat
              projectId={projectId}
              events={events}
              sessionId={sessionId}
              onAskReply={replyToAsk}
            />
          </Panel>
          <Separator className="w-px bg-border transition-colors hover:bg-primary" />
          <Panel id="graph" defaultSize="60%" minSize="32%">
            <div className="relative h-full min-h-0 w-full">
              <WorkflowGraphV2
                workflow={draftDef}
                authoring
                onChange={handleGraphChange}
              />
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  );
}
