// Section 17d.3 — Inline-form create modal for new pods.
//
// The buildout originally proposed reusing CreateAgentModal's conversational
// interview flow, but post-17e.2 that path writes flat-files that
// listResolvedAgents no longer surfaces. The plan revised to a simple inline
// form (architectural-sanity-check applied to a stale buildout text). The
// orchestrator can still create pods via pc_update_agent_* MCP tools; this
// modal is the user-driven path.

import { useEffect, useRef, useState } from 'react';

import { api, type CreatePodInput, type Pod } from '@/api/client';

interface CreatePodModalProps {
  onClose: () => void;
  onCreated: (pod: Pod) => void;
}

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

export function CreatePodModal({ onClose, onCreated }: CreatePodModalProps) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const name = form.name.trim();
    if (!name) {
      setError('Name is required.');
      return;
    }
    const input: CreatePodInput = { name };
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
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col border border-border bg-card text-foreground">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">New agent</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <form onSubmit={submit} className="flex-1 overflow-y-auto px-4 py-3">
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
                onChange={(e) =>
                  setForm((p) => ({ ...p, description: e.target.value }))
                }
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
                  onChange={(e) =>
                    setForm((p) => ({ ...p, maxTurns: e.target.value }))
                  }
                  placeholder="(no cap)"
                  className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                />
              </Field>
              <Field label="Output destination">
                <input
                  type="text"
                  value={form.outputDestination}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, outputDestination: e.target.value }))
                  }
                  placeholder="(optional)"
                  className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                />
              </Field>
            </div>
            <Field label="Tools" hint="Comma-separated allowlist. Leave empty to inherit CC defaults.">
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
        </form>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
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
            onClick={submit}
            disabled={busy || !form.name.trim()}
            className="border border-primary bg-primary/30 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create agent'}
          </button>
        </footer>
      </div>
    </div>
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
