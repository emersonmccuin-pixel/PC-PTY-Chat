// 4b.4 / 4f.2b — Conversational "Create / Edit Workflow" modal.
//
// Mirrors CreateAgentModal.tsx's chat surface (spawning + bubble list +
// composer + WS-envelope routing) and adds a wider layout with a
// react-resizable-panels splitter: chat on the left (~40%), live workflow
// graph (B2 = 4b.5 + 4b.6) on the right (~60%). The graph re-renders
// whenever the interview pushes a `pc_update_workflow_draft`.
//
// 4f.2b — edit mode: when `editingWorkflow` is supplied, the modal grows a
// tab strip ("Conversation" / "Raw YAML"). The Conversation tab boots the
// same workflow-creator session, auto-sends an `[edit-mode workflowId="…"]`
// handoff after state → ready so the model treats it as a refinement
// session (commits via `pc_edit_workflow` instead of `pc_create_workflow`).
// The handoff bubble itself is filtered out of the chat panel — the model
// receives it; the user sees the clean conversation. The Raw YAML tab is
// the PM escape hatch — direct textarea over the on-disk YAML, saved via
// PUT { yamlText } so comments + key order survive the round trip.
//
// WS envelope contract:
//   workflow-creator-state  — session lifecycle
//   workflow-creator-event  — { event: { kind: 'user'|'assistant', text, ts } }
//   workflow-creator-exit   — session ended
//   workflow-creator-draft  — { sessionId, def } — pushed by the server when
//                             the model calls pc_update_workflow_draft
//   project-workflows-changed — committed; close the modal so WorkflowList
//                               refreshes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { api, WorkflowValidationError } from '@/api/client';
import type { Workflow } from '@/api/client';
import type { WsEnvelope, WsOutbound } from '@/hooks/use-project-ws';
import { AskCard } from './AskCard';
import { WorkflowGraph } from './WorkflowGraph';

interface EditingWorkflow {
  id: string;
  def: Workflow;
  yamlText: string;
}

interface CreateWorkflowModalProps {
  projectId: string;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
  onClose: () => void;
  /** When set, the modal opens in edit mode: pre-populated draft, edit-mode
   *  handoff message sent on boot, Raw YAML tab available. */
  editingWorkflow?: EditingWorkflow;
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

type TabId = 'conversation' | 'raw';

/** 4f.2b handoff prefix. The first user message in an edit-mode session
 *  starts with this — used by the model to switch behavior AND used by the
 *  chat panel to filter the bubble out of view. */
const EDIT_HANDOFF_PREFIX = '[edit-mode workflowId=';

function buildEditHandoff(editing: EditingWorkflow): string {
  return [
    `[edit-mode workflowId="${editing.id}"]`,
    '',
    'Here is the current definition of the workflow the user wants to edit:',
    '',
    '```json',
    JSON.stringify(editing.def, null, 2),
    '```',
    '',
    "Acknowledge in one short line that you've loaded it, then wait for the user to describe what they want to change. Don't restart the interview from scratch — they already authored this. Commit via pc_edit_workflow.",
  ].join('\n');
}

export function CreateWorkflowModal({
  projectId,
  events,
  send,
  onClose,
  editingWorkflow,
}: CreateWorkflowModalProps) {
  const isEditMode = Boolean(editingWorkflow);
  const [items, setItems] = useState<Item[]>([]);
  const [answeredAsks, setAnsweredAsks] = useState<Record<string, string>>({});
  const [state, setState] = useState<SessionState>('spawning');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draftDef, setDraftDef] = useState<Workflow | null>(editingWorkflow?.def ?? null);
  const [tab, setTab] = useState<TabId>('conversation');

  // Raw-YAML tab state (4f.2b — folds in the prior EditWorkflowModal surface).
  const [rawYaml, setRawYaml] = useState<string>(editingWorkflow?.yamlText ?? '');
  const [originalYaml, setOriginalYaml] = useState<string>(editingWorkflow?.yamlText ?? '');
  const [savingRaw, setSavingRaw] = useState(false);
  const [rawErr, setRawErr] = useState<string | null>(null);
  const [rawFieldErrors, setRawFieldErrors] = useState<
    { path: string; message: string }[]
  >([]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Snap consumed-envelope count to events.length on mount so we skip
  // pre-modal envelopes from concurrent orchestrator activity. Hoisted above
  // the boot effect for the same reason as CreateAgentModal.
  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  // Track whether the edit-mode handoff has been fired so it doesn't re-fire
  // on every state transition.
  const handoffSentRef = useRef(false);
  const editingRef = useRef(editingWorkflow);
  editingRef.current = editingWorkflow;

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setAnsweredAsks({});
    setState('spawning');
    setError(null);
    setSessionId(null);
    // Edit-mode: pre-populate draft so the visualizer shows the existing
    // shape immediately, before the model's first acknowledgment.
    setDraftDef(editingRef.current?.def ?? null);
    handoffSentRef.current = false;
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

  // 4f.2b — once the session is ready in edit mode, fire the handoff message
  // exactly once. The model treats it as the first user turn, switches into
  // edit-mode behavior per workflow-creator-prompt.md, and awaits the user's
  // actual change request.
  useEffect(() => {
    if (!isEditMode) return;
    if (handoffSentRef.current) return;
    if (state !== 'ready') return;
    const editing = editingRef.current;
    if (!editing) return;
    handoffSentRef.current = true;
    const handoff = buildEditHandoff(editing);
    void api.sendWorkflowCreator(projectId, handoff).catch((e: unknown) => {
      setError(`failed to send edit-mode handoff: ${(e as Error).message}`);
      handoffSentRef.current = false;
    });
  }, [state, isEditMode, projectId]);

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
          // 4f.2b — filter out the edit-mode handoff bubble. The model still
          // receives it (it was sent via the API); the chat panel hides it
          // so the user sees a clean conversation starting from the model's
          // acknowledgment.
          if (ev.text.startsWith(EDIT_HANDOFF_PREFIX)) continue;
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
        // pc_create_workflow / pc_edit_workflow committed → close so the
        // WorkflowList refreshes. Filter to our session's id via the
        // envelope's workflow id when present so a stray external commit
        // doesn't kill an in-progress edit on a different workflow.
        const change = env as { change?: string; id?: string };
        if (isEditMode && editingRef.current && change.id && change.id !== editingRef.current.id) {
          continue;
        }
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

  async function handleSaveRaw() {
    if (!editingWorkflow) return;
    setSavingRaw(true);
    setRawErr(null);
    setRawFieldErrors([]);
    try {
      await api.editWorkflow(projectId, editingWorkflow.id, { yamlText: rawYaml });
      setOriginalYaml(rawYaml);
      // project-workflows-changed will close the modal on broadcast — but in
      // case the broadcast races or the user wants to keep editing, the
      // dirty-check resets cleanly.
    } catch (e) {
      if (e instanceof WorkflowValidationError) {
        setRawFieldErrors(e.errors);
        setRawErr(e.message);
      } else {
        setRawErr((e as Error).message);
      }
    } finally {
      setSavingRaw(false);
    }
  }

  const canSend = draft.trim().length > 0 && state !== 'spawning' && state !== 'exited';
  const rawDirty = isEditMode && rawYaml !== originalYaml;
  const canSaveRaw = rawDirty && !savingRaw;
  const statusLabel = useMemo<string>(() => {
    if (error) return error;
    if (state === 'spawning') return 'Starting…';
    if (state === 'thinking') return 'Thinking…';
    if (state === 'exited') return 'Session ended';
    return 'Ready';
  }, [state, error]);

  const title = isEditMode ? `Edit workflow — ${editingWorkflow!.id}` : 'Create workflow';
  const subtitle = isEditMode
    ? "Tell the model what you want to change. Or hop to Raw YAML to edit directly."
    : 'Interview drives a complete workflow. The visualizer updates as the draft forms. Close to cancel.';

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

        {isEditMode && (
          <nav className="flex shrink-0 gap-1 border-b border-border bg-background px-2 pt-1">
            <TabButton id="conversation" active={tab} onPick={setTab}>
              Conversation
            </TabButton>
            <TabButton id="raw" active={tab} onPick={setTab}>
              Raw YAML
            </TabButton>
          </nav>
        )}

        {tab === 'raw' && isEditMode ? (
          <RawYamlBody
            yaml={rawYaml}
            onChange={setRawYaml}
            onSave={() => void handleSaveRaw()}
            canSave={canSaveRaw}
            saving={savingRaw}
            dirty={rawDirty}
            error={rawErr}
            fieldErrors={rawFieldErrors}
          />
        ) : (
          <Group orientation="horizontal" id="pc-create-workflow-split" className="flex-1 min-h-0">
            <Panel id="chat" defaultSize="40%" minSize="28%">
              <div className="flex h-full flex-col">
                <BubbleList
                  items={items}
                  thinking={state === 'thinking'}
                  answeredAsks={answeredAsks}
                  onAskReply={replyToAsk}
                  emptyHint={
                    isEditMode
                      ? 'Loading the existing workflow into the editor…'
                      : 'Tell the workflow-creator what you want this workflow to do. It will interview you, draft the workflow, and commit when you confirm.'
                  }
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
                          : isEditMode
                            ? 'Describe what you want to change. Enter sends, Shift+Enter for a newline.'
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
        )}
      </div>
    </div>
  );
}

function TabButton({
  id,
  active,
  onPick,
  children,
}: {
  id: TabId;
  active: TabId;
  onPick: (id: TabId) => void;
  children: React.ReactNode;
}) {
  const isActive = id === active;
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      className={
        'border border-b-0 px-3 py-1.5 text-xs font-medium uppercase tracking-wider ' +
        (isActive
          ? 'border-border bg-card text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}

function RawYamlBody({
  yaml,
  onChange,
  onSave,
  canSave,
  saving,
  dirty,
  error,
  fieldErrors,
}: {
  yaml: string;
  onChange: (next: string) => void;
  onSave: () => void;
  canSave: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  fieldErrors: { path: string; message: string }[];
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2 text-xs">
        <span className="text-muted-foreground">
          Edit the YAML directly. Save validates against the same rules the chat does.
          {dirty && <span className="ml-2 italic text-foreground">Unsaved changes.</span>}
        </span>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {(error || fieldErrors.length > 0) && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <div className="font-medium">{error ?? 'Invalid workflow'}</div>
          {fieldErrors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 font-mono">
              {fieldErrors.map((e, i) => (
                <li key={i}>
                  <span className="text-foreground/80">{e.path}</span>: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <textarea
        value={yaml}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none border-0 bg-background p-4 font-mono text-xs leading-relaxed outline-none focus:bg-background"
      />
    </div>
  );
}

function BubbleList({
  items,
  thinking,
  answeredAsks,
  onAskReply,
  emptyHint,
}: {
  items: Item[];
  thinking: boolean;
  answeredAsks: Record<string, string>;
  onAskReply: (toolUseId: string, answer: string) => void;
  emptyHint: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, thinking]);

  return (
    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
      {items.length === 0 && !thinking && (
        <p className="text-xs italic text-muted-foreground">{emptyHint}</p>
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
