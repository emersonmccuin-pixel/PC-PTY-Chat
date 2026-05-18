// 3d — Form-based agent editor with a YAML escape hatch.
//
// Replaces the raw-textarea editor that was here before. Form view exposes
// the visible fields per Section 3 D8 (name read-only, description, color,
// model, effort, maxTurns, tools, body). YAML view shows the raw file text
// for power users who need to touch fields the form doesn't surface
// (mcpServers, memory, hooks, skills, isolation, permissionMode, etc.) —
// round-trip safety lives in the server's `serializeAgentFile` path so
// unknown frontmatter keys / comments / key order survive form edits.
//
// Validation is server-authoritative: form-submit POSTs `{ def, markdown }`,
// server calls `validateAgentDef` and returns 400 + `errors[]` on failure;
// field-level errors surface inline keyed by their `field` path.

import { useEffect, useMemo, useState } from 'react';

import {
  AGENT_COLORS,
  AGENT_EFFORTS,
  AGENT_MODEL_SHORTCUTS,
  api,
  type AgentColor,
  type AgentDef,
  type AgentEffort,
  type AgentValidationIssue,
  type ResolvedAgent,
} from '@/api/client';
import {
  AgentBodyTemplateError,
  EXAMPLE_AGENT_BODY_CONTEXT,
  renderAgentBody,
} from '@/lib/agent-body';

const COMMON_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'NotebookRead',
  'NotebookEdit',
];

const COMMON_MCP_TOOLS: readonly string[] = [
  'mcp__pc-rig__pc_log',
  'mcp__pc-rig__pc_complete_node',
  'mcp__pc-rig__pc_node_failed',
  'mcp__pc-rig__pc_run_workflow',
  'mcp__pc-rig__pc_create_worktree',
  'mcp__pc-rig__pc_list_worktrees',
  'mcp__pc-rig__pc_destroy_worktree',
  'mcp__pc-rig__pc_create_work_item',
  'mcp__pc-rig__pc_move_work_item',
  'mcp__pc-rig__pc_update_work_item',
];

const COLOR_SWATCH: Record<AgentColor, string> = {
  red: 'bg-red-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  purple: 'bg-purple-500',
  orange: 'bg-orange-500',
  pink: 'bg-pink-500',
  cyan: 'bg-cyan-500',
};

type View = 'form' | 'yaml';

interface Props {
  projectId: string;
  agent: ResolvedAgent;
  onClose: () => void;
  onSaved: () => void;
}

export function AgentEditor({ projectId, agent, onClose, onSaved }: Props) {
  // The server gives us a parsed `def` + `markdown` when the file is valid,
  // alongside the raw `body`. Form view drives `def` + `markdown`; YAML view
  // drives `body`. Per-view dirty tracking keeps the save button honest.
  const [view, setView] = useState<View>('form');

  const initialDef: AgentDef | null = useMemo(() => agent.def ?? null, [agent.def]);
  const initialMarkdown = agent.markdown ?? '';
  const initialBody = agent.body;

  const [def, setDef] = useState<AgentDef | null>(initialDef);
  const [markdown, setMarkdown] = useState<string>(initialMarkdown);
  const [body, setBody] = useState<string>(initialBody);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Re-seed local state when the editor opens on a different agent.
  useEffect(() => {
    setDef(initialDef);
    setMarkdown(initialMarkdown);
    setBody(initialBody);
    setView(initialDef ? 'form' : 'yaml');
    setErr(null);
    setFieldErrors({});
    setSavedNote(null);
  }, [agent.name, initialDef, initialMarkdown, initialBody]);

  const formDirty =
    view === 'form' && (defChanged(def, initialDef) || markdown !== initialMarkdown);
  const yamlDirty = view === 'yaml' && body !== initialBody;
  const canSave = (formDirty || yamlDirty) && !busy;
  const formEditable = def !== null;

  function patchDef(patch: Partial<AgentDef>) {
    if (!def) return;
    setDef({ ...def, ...patch });
    setSavedNote(null);
  }

  function switchView(next: View) {
    if (view === next) return;
    const dirty = view === 'form' ? formDirty : yamlDirty;
    if (
      dirty &&
      !window.confirm(
        `You have unsaved ${view === 'form' ? 'Form' : 'YAML'} edits. Switch views and discard them?`,
      )
    ) {
      return;
    }
    if (next === 'form' && !formEditable) {
      setErr('Cannot show Form view: file failed to parse. Fix the YAML first.');
      return;
    }
    // Reset the other view's local state back to the server baseline so the
    // user doesn't see stale edits if they switch back later.
    if (view === 'form') {
      setDef(initialDef);
      setMarkdown(initialMarkdown);
    } else {
      setBody(initialBody);
    }
    setView(next);
    setErr(null);
    setFieldErrors({});
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    setFieldErrors({});
    setSavedNote(null);
    try {
      if (view === 'form') {
        if (!def) throw new Error('form not available — open YAML view');
        await api.updateProjectAgent(projectId, agent.name, { def, markdown });
      } else {
        await api.updateProjectAgent(projectId, agent.name, { body });
      }
      setSavedNote('Saved. Restart the orchestrator to pick up the change.');
      onSaved();
    } catch (e) {
      const error = e as Error & { fieldErrors?: AgentValidationIssue[] };
      setErr(error.message);
      if (error.fieldErrors) {
        const map: Record<string, string> = {};
        for (const fe of error.fieldErrors) map[fe.field] = fe.message;
        setFieldErrors(map);
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveToGlobal() {
    if (busy) return;
    const verb =
      agent.kind === 'override'
        ? 'Replace the global with this project version'
        : 'Add this agent to the global library';
    const consequence =
      agent.kind === 'override'
        ? 'The existing global will be overwritten. Future projects pick up this version as the new baseline.'
        : 'Future projects will see this agent in their Global list.';
    if (!window.confirm(`${verb}?\n\n${consequence}\n\nProceed?`)) return;
    setBusy(true);
    setErr(null);
    setSavedNote(null);
    try {
      const { kind } = await api.promoteAgentToGlobal(projectId, agent.name);
      setSavedNote(
        kind === 'replaced-global'
          ? 'Saved to library — replaced the existing global.'
          : 'Saved to library — added as a new global.',
      );
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <KindBadge kind={agent.kind} />
          <span className="truncate font-mono text-xs text-foreground">{agent.name}</span>
        </div>
        <div className="flex items-center gap-1">
          <ViewTab label="Form" active={view === 'form'} onClick={() => switchView('form')} />
          <ViewTab label="YAML" active={view === 'yaml'} onClick={() => switchView('yaml')} />
          <button
            onClick={onClose}
            className="ml-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
      </div>

      {!formEditable && view === 'form' && (
        <p className="mb-2 text-xs text-destructive">
          File failed to parse — using YAML view. {agent.parseError?.message}
        </p>
      )}

      {view === 'form' && def && (
        <FormView
          def={def}
          markdown={markdown}
          fieldErrors={fieldErrors}
          onPatch={patchDef}
          onMarkdownChange={(v) => {
            setMarkdown(v);
            setSavedNote(null);
          }}
        />
      )}

      {view === 'yaml' && (
        <YamlView
          body={body}
          onChange={(v) => {
            setBody(v);
            setSavedNote(null);
          }}
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={!canSave}
          className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {(agent.kind === 'project' || agent.kind === 'override') && (
          <button
            onClick={() => void saveToGlobal()}
            disabled={busy}
            className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            Save to global
          </button>
        )}
        {agent.kind === 'global' && (
          <span className="text-xs text-muted-foreground">
            Editing creates a project override. The global stays unchanged elsewhere.
          </span>
        )}
      </div>
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
      {savedNote && <p className="mt-2 text-xs text-success">{savedNote}</p>}
    </div>
  );
}

// ─── Sub-views ───────────────────────────────────────────────────────────────

function FormView({
  def,
  markdown,
  fieldErrors,
  onPatch,
  onMarkdownChange,
}: {
  def: AgentDef;
  markdown: string;
  fieldErrors: Record<string, string>;
  onPatch: (patch: Partial<AgentDef>) => void;
  onMarkdownChange: (next: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Name" hint="Filename slug. Locked — delete + recreate to rename.">
        <input
          value={def.name}
          readOnly
          className="w-full border border-border bg-muted px-2 py-1 font-mono text-xs text-muted-foreground"
        />
      </Field>

      <Field
        label="Description"
        hint="One or two sentences — when to use this agent."
        error={fieldErrors.description}
      >
        <textarea
          value={def.description}
          onChange={(e) => onPatch({ description: e.target.value })}
          rows={2}
          className="w-full border border-border bg-background px-2 py-1 text-xs"
        />
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {def.description.length} / 280
        </p>
      </Field>

      <Field label="Color" hint="Cosmetic tag for transcripts.">
        <div className="flex flex-wrap items-center gap-1.5">
          {AGENT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onPatch({ color: def.color === c ? undefined : c })}
              className={`h-6 w-6 border ${COLOR_SWATCH[c]} ${
                def.color === c ? 'border-foreground' : 'border-border'
              }`}
              title={c}
            />
          ))}
          <button
            type="button"
            onClick={() => onPatch({ color: undefined })}
            className="border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
          >
            Clear
          </button>
        </div>
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Model" error={fieldErrors.model}>
          <ModelPicker value={def.model} onChange={(v) => onPatch({ model: v })} />
        </Field>
        <Field label="Effort" error={fieldErrors.effort}>
          <select
            value={def.effort ?? ''}
            onChange={(e) =>
              onPatch({ effort: (e.target.value || undefined) as AgentEffort | undefined })
            }
            className="w-full border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">— default —</option>
            {AGENT_EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Max turns" error={fieldErrors.maxTurns}>
          <input
            type="number"
            min={1}
            value={def.maxTurns ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') onPatch({ maxTurns: undefined });
              else {
                const n = Number(v);
                if (Number.isFinite(n)) onPatch({ maxTurns: Math.trunc(n) });
              }
            }}
            className="w-full border border-border bg-background px-2 py-1 text-xs"
          />
        </Field>
      </div>

      <Field
        label="Tools"
        hint="Allowlist. Empty list = no tools available."
        error={fieldErrors.tools}
      >
        <ToolsPicker tools={def.tools ?? []} onChange={(t) => onPatch({ tools: t })} />
      </Field>

      <Field
        label="System prompt (body)"
        hint="The agent's instructions. Markdown. {{input}}, {{worktree}}, {{wi.title}}, etc. render at dispatch time."
      >
        <textarea
          value={markdown}
          onChange={(e) => onMarkdownChange(e.target.value)}
          rows={14}
          className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      </Field>

      <BodyPreview markdown={markdown} />
    </div>
  );
}

function BodyPreview({ markdown }: { markdown: string }) {
  const [open, setOpen] = useState(false);

  const result = useMemo<{ kind: 'ok'; rendered: string } | { kind: 'err'; message: string }>(
    () => {
      try {
        return { kind: 'ok', rendered: renderAgentBody(markdown, EXAMPLE_AGENT_BODY_CONTEXT) };
      } catch (e) {
        if (e instanceof AgentBodyTemplateError) {
          return { kind: 'err', message: e.message };
        }
        return { kind: 'err', message: String(e) };
      }
    },
    [markdown],
  );

  const hasPlaceholders = /\{\{[^{}]+\}\}/.test(markdown);

  return (
    <div className="border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between bg-muted/40 px-2 py-1 text-left text-[11px] hover:bg-muted"
      >
        <span className="font-medium">
          Preview rendered body{' '}
          <span className="text-muted-foreground">(sample workflow context)</span>
        </span>
        <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-2 py-2">
          {!hasPlaceholders && (
            <p className="text-[10px] text-muted-foreground">
              No <code>{'{{var}}'}</code> placeholders found. The body renders verbatim.
            </p>
          )}
          {hasPlaceholders && (
            <p className="text-[10px] text-muted-foreground">
              Substituted with example values (<code>input</code>,{' '}
              <code>worktree</code>, <code>workflow.id</code>, <code>node.id</code>,{' '}
              <code>project.*</code>, <code>wi.*</code>) — the real workflow run supplies
              these at dispatch time.
            </p>
          )}
          {result.kind === 'ok' && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap bg-background px-2 py-1 font-mono text-[11px]">
              {result.rendered}
            </pre>
          )}
          {result.kind === 'err' && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">
              {result.message}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function YamlView({ body, onChange }: { body: string; onChange: (next: string) => void }) {
  return (
    <div>
      <textarea
        value={body}
        onChange={(e) => onChange(e.target.value)}
        rows={22}
        className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
      />
      <p className="mt-1 text-[10px] text-muted-foreground">
        Raw file (frontmatter + body). Edits round-trip preserve comments and unknown keys.
      </p>
    </div>
  );
}

// ─── Pickers ─────────────────────────────────────────────────────────────────

function ModelPicker({
  value,
  onChange,
}: {
  value?: string;
  onChange: (next: string | undefined) => void;
}) {
  const isShortcut = value && (AGENT_MODEL_SHORTCUTS as readonly string[]).includes(value);
  const selectValue = value === undefined ? '' : isShortcut ? value : '__custom__';
  return (
    <div className="space-y-1">
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') onChange(undefined);
          else if (v === '__custom__') onChange(value && !isShortcut ? value : 'claude-opus-4-7');
          else onChange(v);
        }}
        className="w-full border border-border bg-background px-2 py-1 text-xs"
      >
        <option value="">— inherit —</option>
        {AGENT_MODEL_SHORTCUTS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value="__custom__">custom…</option>
      </select>
      {selectValue === '__custom__' && (
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder="claude-opus-4-7"
          className="w-full border border-border bg-background px-2 py-1 font-mono text-[11px]"
        />
      )}
    </div>
  );
}

function ToolsPicker({
  tools,
  onChange,
}: {
  tools: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const set = new Set(tools);

  const add = (t: string) => {
    const trimmed = t.trim();
    if (!trimmed || set.has(trimmed)) return;
    onChange([...tools, trimmed]);
  };
  const remove = (t: string) => onChange(tools.filter((x) => x !== t));
  const toggle = (t: string) => (set.has(t) ? remove(t) : add(t));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {tools.length === 0 && (
          <span className="text-[11px] text-muted-foreground">none — agent has no tools</span>
        )}
        {tools.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]"
          >
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              className="text-muted-foreground hover:text-destructive"
              aria-label={`remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
              setDraft('');
            }
          }}
          placeholder="Add tool… (Enter to add)"
          className="flex-1 border border-border bg-background px-2 py-1 font-mono text-[11px]"
        />
        <button
          type="button"
          onClick={() => {
            add(draft);
            setDraft('');
          }}
          disabled={!draft.trim()}
          className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <ToolQuickAdd label="Built-in" options={COMMON_TOOLS} active={set} onToggle={toggle} />
      <ToolQuickAdd label="MCP (pc-rig)" options={COMMON_MCP_TOOLS} active={set} onToggle={toggle} />
    </div>
  );
}

function ToolQuickAdd({
  label,
  options,
  active,
  onToggle,
}: {
  label: string;
  options: readonly string[];
  active: Set<string>;
  onToggle: (t: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((t) => {
          const on = active.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => onToggle(t)}
              className={`border px-1.5 py-0.5 font-mono text-[10px] ${
                on
                  ? 'border-primary bg-primary/20 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-muted'
              }`}
            >
              {t}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Misc ────────────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-0.5 text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function ViewTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 text-[10px] uppercase tracking-wide ${
        active
          ? 'border border-border bg-muted text-foreground'
          : 'border border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}

function KindBadge({ kind }: { kind: ResolvedAgent['kind'] }) {
  const map: Record<ResolvedAgent['kind'], { label: string; cls: string }> = {
    global: { label: 'Global', cls: 'bg-muted text-muted-foreground' },
    override: { label: 'Customized', cls: 'bg-warning/20 text-warning-foreground' },
    project: { label: 'Project', cls: 'bg-primary/20 text-foreground' },
  };
  const { label, cls } = map[kind];
  return (
    <span className={`shrink-0 px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

function defChanged(a: AgentDef | null, b: AgentDef | null): boolean {
  if (a === b) return false;
  if (!a || !b) return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}
