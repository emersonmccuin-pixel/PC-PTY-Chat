// "+ Add agent" modal. Three tabs:
//   - From global pool (default when pool has pickable globals): pick a
//     user-promoted global pod and clone it into THIS project. Skips stock
//     pods (always-visible in the Built-in section) + globals whose name is
//     already a project pod here. Clone via POST /clone-to-project.
//   - Conversational: dormant Start button → on click, spawns agent-designer
//     (transient PtySession against the agent-designer pod) and renders
//     AgentDesignerChat. Closing the modal tears down the session via the
//     explicit close handler.
//   - Manual: the plain inline form (name / description / prompt / model /
//     effort / max-turns / tools / output destination).
//
// Tabs stay MOUNTED across switches (display toggle, not conditional
// render) so a started chat survives a toggle to Manual and back.

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  api,
  type CreatePodInput,
  type Pod,
  type Project,
} from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { AgentDesignerChat } from './AgentDesignerChat';

interface CreatePodModalProps {
  project: Project;
  events: WsEnvelope[];
  /** Names of project-scope pods already in THIS project. Used by the
   *  global-pool picker to hide globals whose name would collide. */
  existingProjectPodNames?: string[];
  onClose: () => void;
  onCreated: (pod: Pod) => void;
}

type TabKey = 'global-pool' | 'conversational' | 'manual';

export function CreatePodModal({
  project,
  events,
  existingProjectPodNames,
  onClose,
  onCreated,
}: CreatePodModalProps) {
  const [globalPool, setGlobalPool] = useState<Pod[] | null>(null);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('global-pool');
  const [convoStarted, setConvoStarted] = useState(false);
  const [convoStarting, setConvoStarting] = useState(false);
  const [convoStartError, setConvoStartError] = useState<string | null>(null);
  const [convoSessionId, setConvoSessionId] = useState<string | null>(null);
  const initialTabSet = useRef(false);

  const projectNamesSet = useMemo(
    () => new Set(existingProjectPodNames ?? []),
    [existingProjectPodNames],
  );

  const pickableGlobals = useMemo(() => {
    if (!globalPool) return [];
    return globalPool.filter(
      (p) =>
        p.scope === 'global' &&
        p.origin !== 'stock' &&
        !projectNamesSet.has(p.name),
    );
  }, [globalPool, projectNamesSet]);

  // Load the global pool once on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .listPods()
      .then((pods) => {
        if (!cancelled) setGlobalPool(pods);
      })
      .catch((e) => {
        if (!cancelled) setPoolErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once we know the pool is empty, snap to the Conversational tab the
  // first time. After that, respect user navigation.
  useEffect(() => {
    if (initialTabSet.current) return;
    if (globalPool === null) return; // pool still loading
    initialTabSet.current = true;
    if (pickableGlobals.length === 0) setTab('conversational');
  }, [globalPool, pickableGlobals.length]);

  // Explicit teardown — fire only from user-initiated close, NOT from
  // useEffect cleanup (Strict Mode double-invoke would kill the spawn
  // ~50ms after start, producing 16-byte silent transcripts).
  function handleClose() {
    if (convoStarted) {
      void api.stopAgentDesigner(project.id).catch(() => {
        /* best-effort */
      });
    }
    onClose();
  }

  async function handleStartConversation() {
    if (convoStarting || convoStarted) return;
    setConvoStartError(null);
    setConvoStarting(true);
    try {
      // Fire-and-track. The HTTP response carries the spawn's initial
      // state, but WS envelopes drive the live state in AgentDesignerChat
      // — don't setState off the response or we risk the transient-modal
      // start-race ([[transient-modal-state-race]]).
      const started = await api.startAgentDesigner(project.id);
      setConvoSessionId(started.sessionId);
      setConvoStarted(true);
    } catch (e) {
      setConvoStartError((e as Error).message);
    } finally {
      setConvoStarting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-[92vh] w-[96vw] max-w-[1600px] flex-col border border-border bg-card text-foreground shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">Add agent</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <TabStrip value={tab} onChange={setTab} />

        <div className="relative min-h-0 flex-1">
          <TabPanel active={tab === 'global-pool'}>
            <GlobalPoolPanel
              project={project}
              pool={globalPool}
              pickable={pickableGlobals}
              error={poolErr}
              onPicked={(newPod) => {
                onCreated(newPod);
              }}
            />
          </TabPanel>

          <TabPanel active={tab === 'conversational'}>
            {convoStarted ? (
              <AgentDesignerChat
                project={project}
                events={events}
                sessionId={convoSessionId}
              />
            ) : (
              <StartScreen
                starting={convoStarting}
                error={convoStartError}
                onStart={() => void handleStartConversation()}
              />
            )}
          </TabPanel>

          <TabPanel active={tab === 'manual'}>
            <ManualForm project={project} onClose={handleClose} onCreated={onCreated} />
          </TabPanel>
        </div>
      </div>
    </div>
  );
}

// ── Tab strip + panel ─────────────────────────────────────────────────────

function TabStrip({
  value,
  onChange,
}: {
  value: TabKey;
  onChange: (t: TabKey) => void;
}) {
  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-border bg-card px-4 pt-2">
      <TabButton active={value === 'global-pool'} onClick={() => onChange('global-pool')}>
        From global pool
      </TabButton>
      <TabButton active={value === 'conversational'} onClick={() => onChange('conversational')}>
        Conversational
      </TabButton>
      <TabButton active={value === 'manual'} onClick={() => onChange('manual')}>
        Manual
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 14px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        borderStyle: 'solid',
        borderWidth: '1px 1px 0 1px',
        borderRadius: '6px 6px 0 0',
        background: active ? 'rgba(240, 208, 128, 0.30)' : 'rgba(240, 208, 128, 0.075)',
        color: active ? '#f0e4c4' : '#9a8e7a',
        fontWeight: active ? 600 : 400,
        borderColor: active ? 'rgba(240, 208, 128, 0.60)' : 'rgba(240, 208, 128, 0.15)',
        marginBottom: active ? -1 : 0,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function TabPanel({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ display: active ? 'flex' : 'none' }}
      className="absolute inset-0 flex-col"
    >
      {children}
    </div>
  );
}

// ── Global pool tab — pick + clone ────────────────────────────────────────

function GlobalPoolPanel({
  project,
  pool,
  pickable,
  error,
  onPicked,
}: {
  project: Project;
  pool: Pod[] | null;
  pickable: Pod[];
  error: string | null;
  onPicked: (newPod: Pod) => void;
}) {
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);

  async function pick(pod: Pod) {
    if (cloningId) return;
    setRowErr(null);
    setCloningId(pod.id);
    try {
      const { pod: cloned } = await api.clonePodToProject(pod.id, project.id);
      onPicked(cloned);
    } catch (e) {
      setRowErr((e as Error).message);
    } finally {
      setCloningId(null);
    }
  }

  if (pool === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading global pool…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (pickable.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <div className="max-w-md text-sm text-muted-foreground">
          No agents in the global pool yet. Use <span className="font-medium text-foreground">Conversational</span> or{' '}
          <span className="font-medium text-foreground">Manual</span> to design one — then{' '}
          <span className="font-medium text-foreground">Promote to global</span> later to share across projects.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        Adding from the pool clones the agent into this project. Edits here don't touch the global copy.
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-1">
          {pickable.map((pod) => (
            <div
              key={pod.id}
              className="grid grid-cols-[1fr_auto] items-center gap-4 border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <div className="font-medium text-foreground">{pod.name}</div>
                {pod.description && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {pod.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void pick(pod)}
                disabled={cloningId !== null}
                className="border border-border bg-card px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                {cloningId === pod.id ? 'Adding…' : 'Add'}
              </button>
            </div>
          ))}
        </div>
        {rowErr && (
          <div className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {rowErr}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Conversational tab — dormant start screen ─────────────────────────────

function StartScreen({
  starting,
  error,
  onStart,
}: {
  starting: boolean;
  error: string | null;
  onStart: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="max-w-md text-sm text-muted-foreground">
        Design a new agent by chatting with <span className="font-mono text-foreground">agent-designer</span>.
        It will ask what the agent should do, what tools it needs, and create the pod when you're ready.
      </div>
      <button
        type="button"
        onClick={onStart}
        disabled={starting}
        className="bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {starting ? 'Starting…' : 'Start agent designer'}
      </button>
      {error && (
        <div className="max-w-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

// ── Manual tab — the plain form (lifted from the pre-tabs CreatePodModal) ─

interface FormState {
  name: string;
  description: string;
  prompt: string;
  model: string;
  effort: string;
  maxTurns: string;
  tools: string;
  outputDestination: string;
}

const INITIAL: FormState = {
  name: '',
  description: '',
  prompt: '',
  model: '',
  effort: '',
  maxTurns: '',
  tools: '',
  outputDestination: '',
};

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function ManualForm({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: (pod: Pod) => void;
}) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  async function submit() {
    if (busy) return;
    const name = form.name.trim();
    if (!name) {
      setError('Name is required.');
      return;
    }
    const input: CreatePodInput = {
      name,
      scope: 'project',
      projectId: project.id,
    };
    if (form.description.trim()) input.description = form.description.trim();
    if (form.prompt) input.prompt = form.prompt;
    if (form.model.trim()) input.model = form.model.trim();
    if (form.effort) input.effort = form.effort;
    if (form.maxTurns.trim()) {
      const n = Number(form.maxTurns);
      if (!Number.isInteger(n) || n <= 0) {
        setError('Max turns must be a positive integer.');
        return;
      }
      input.maxTurns = n;
    }
    if (form.tools.trim()) {
      input.tools = form.tools
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (form.outputDestination.trim()) {
      input.outputDestination = form.outputDestination.trim();
    }
    setBusy(true);
    setError(null);
    try {
      const pod = await api.createPod(input);
      onCreated(pod);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          <Field label="Name" required>
            <input
              ref={nameInputRef}
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="my-agent"
              className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
            />
          </Field>
          <Field label="Description">
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="What this agent does."
              className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
            />
          </Field>
          <Field label="Prompt">
            <textarea
              value={form.prompt}
              onChange={(e) => setForm((p) => ({ ...p, prompt: e.target.value }))}
              rows={8}
              placeholder="You are a..."
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model">
              <input
                type="text"
                value={form.model}
                onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
                placeholder="opus / sonnet / haiku"
                className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
              />
            </Field>
            <Field label="Effort">
              <select
                value={form.effort}
                onChange={(e) => setForm((p) => ({ ...p, effort: e.target.value }))}
                className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
              >
                {EFFORTS.map((opt) => (
                  <option key={opt || '__none__'} value={opt}>
                    {opt || '(default)'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max turns">
              <input
                type="number"
                min={1}
                value={form.maxTurns}
                onChange={(e) => setForm((p) => ({ ...p, maxTurns: e.target.value }))}
                placeholder="(no cap)"
                className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
              />
            </Field>
            <Field label="Output destination">
              <input
                type="text"
                value={form.outputDestination}
                onChange={(e) => setForm((p) => ({ ...p, outputDestination: e.target.value }))}
                placeholder="(optional)"
                className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
              />
            </Field>
          </div>
          <Field
            label="Tools"
            hint="Comma-separated allowlist. Leave empty to inherit CC defaults."
          >
            <input
              type="text"
              value={form.tools}
              onChange={(e) => setForm((p) => ({ ...p, tools: e.target.value }))}
              placeholder="Read, Glob, Grep, mcp__pc-rig__pc_log"
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
          </Field>
        </div>
        {error && (
          <div className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !form.name.trim()}
          className="border border-primary bg-primary/30 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create agent'}
        </button>
      </footer>
    </>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </span>
      {children}
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </label>
  );
}
