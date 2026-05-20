// Q11 — per-project settings.
//
// Trunk scope (docs/session-log.md, Session Q): rename + git remote, agent library picker
// (add from library / edit project copy / save edit back as a new library
// agent), and danger-zone soft-delete + on-disk file removal.
//
// v1's `ProjectSettingsPanel.tsx` is the spiritual vendor target but its UI
// is far larger (stages editor, field schemas, repo bind picker, overrides
// matrix) and depends on shapes that don't exist on the trunk yet. This is
// the minimal panel matching the trunk's endpoints.

import { useEffect, useRef, useState } from 'react';

import { api, type Project, type ResolvedAgent } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useProjectSettingsFocus } from '@/store/project-settings-focus';
import { DeleteProjectFilesModal, SoftDeleteProjectModal } from './ProjectDangerModals';
import { SetupWizardModal } from './SetupWizardModal';
import { AgentEditor } from './project-settings/AgentEditor';
import { CreateAgentModal } from './project-settings/CreateAgentModal';
import { FieldSchemasEditor } from './project-settings/FieldSchemasEditor';
import { StagesEditor } from './project-settings/StagesEditor';

interface ProjectSettingsPanelProps {
  project: Project;
  events: WsEnvelope[];
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
}

type SectionId = 'info' | 'stages' | 'fields' | 'agents' | 'danger';

const SECTIONS: { id: SectionId; label: string; danger?: boolean }[] = [
  { id: 'info', label: 'Project info' },
  { id: 'stages', label: 'Stages' },
  { id: 'fields', label: 'Field schemas' },
  { id: 'agents', label: 'Agents' },
  { id: 'danger', label: 'Danger zone', danger: true },
];

export function ProjectSettingsPanel({
  project,
  events,
  onProjectUpdated,
  onProjectDeleted,
}: ProjectSettingsPanelProps) {
  const [active, setActive] = useState<SectionId>('info');
  const focusTarget = useProjectSettingsFocus((s) => s.target);
  const clearFocus = useProjectSettingsFocus((s) => s.setTarget);

  // Reset to the first section on project switch — a fresh project shouldn't
  // land deep inside another project's danger zone.
  useEffect(() => {
    setActive('info');
  }, [project.id]);

  // /agents ability redirects here — swap to the agents tab and clear.
  useEffect(() => {
    if (focusTarget === 'agents') {
      setActive('agents');
      clearFocus(null);
    }
  }, [focusTarget, clearFocus]);

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold uppercase tracking-wider text-foreground">
          {project.name}
        </h1>
        <p className="text-xs text-muted-foreground">Project settings</p>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-card py-2">
          {SECTIONS.map((s) => {
            const isActive = active === s.id;
            const base = 'block w-full border-l-2 px-3 py-2 text-left text-xs ';
            const state = isActive
              ? 'border-primary bg-muted ' +
                (s.danger ? 'text-destructive font-medium' : 'text-primary font-medium')
              : 'border-transparent hover:bg-muted ' +
                (s.danger ? 'text-destructive/80 hover:text-destructive' : 'text-foreground/80');
            return (
              <button key={s.id} onClick={() => setActive(s.id)} className={base + state}>
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-6 p-6 text-sm">
            <SetupWizardNag project={project} events={events} />

            {active === 'info' && (
              <Section title="Project info">
                <ProjectInfoForm project={project} onSaved={onProjectUpdated} />
              </Section>
            )}

            {active === 'stages' && (
              <Section title="Stages">
                <StagesEditor project={project} onProjectUpdated={onProjectUpdated} />
              </Section>
            )}

            {active === 'fields' && (
              <Section title="Field schemas">
                <FieldSchemasEditor projectId={project.id} />
              </Section>
            )}

            {active === 'agents' && (
              <Section title="Agents">
                <AgentsSection projectId={project.id} events={events} />
              </Section>
            )}

            {active === 'danger' && (
              <Section title="Danger zone">
                <DangerZone project={project} onDeleted={onProjectDeleted} />
              </Section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Project info ────────────────────────────────────────────────────────────

function ProjectInfoForm({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: (next: Project) => void;
}) {
  const [name, setName] = useState(project.name);
  const [gitRemote, setGitRemote] = useState(project.gitRemote ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(project.name);
    setGitRemote(project.gitRemote ?? '');
  }, [project.id, project.name, project.gitRemote]);

  const trimmedName = name.trim();
  const trimmedRemote = gitRemote.trim();
  const dirty =
    trimmedName !== project.name ||
    (trimmedRemote || null) !== (project.gitRemote ?? null);
  const valid = trimmedName.length > 0;

  async function save() {
    if (busy || !dirty || !valid) return;
    setBusy(true);
    setErr(null);
    try {
      const patch: { name?: string; git_remote?: string | null } = {};
      if (trimmedName !== project.name) patch.name = trimmedName;
      const nextRemote = trimmedRemote ? trimmedRemote : null;
      if (nextRemote !== (project.gitRemote ?? null)) patch.git_remote = nextRemote;
      const updated = await api.updateProject(project.id, patch);
      onSaved(updated);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setName(project.name);
    setGitRemote(project.gitRemote ?? '');
    setErr(null);
  }

  return (
    <div className="space-y-3">
      <Field
        label="Display name"
        help={`The folder name on disk and URLs stay locked at ${project.slug}.`}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border border-border bg-background px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Slug" help="Locked after creation.">
        <code className="block break-all bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {project.slug}
        </code>
      </Field>
      <Field label="Folder">
        <code className="block break-all bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {project.folderPath}
        </code>
      </Field>
      <Field label="Git remote" help="Optional. Leave blank to clear.">
        <input
          type="text"
          value={gitRemote}
          onChange={(e) => setGitRemote(e.target.value)}
          placeholder="git@github.com:org/repo.git"
          className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      </Field>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={busy || !dirty || !valid}
          className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={discard}
          disabled={busy || !dirty}
          className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          Discard
        </button>
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </div>
  );
}

// ─── Agents ──────────────────────────────────────────────────────────────────
//
// Section 3 D2 model: globals always appear in every project. Editing a
// global creates a per-project override. Project-only agents are authored
// just for this project (form-editor authoring lands in 3d).

function AgentsSection({
  projectId,
  events,
}: {
  projectId: string;
  events: WsEnvelope[];
}) {
  const [list, setList] = useState<{
    globals: ResolvedAgent[];
    overrides: ResolvedAgent[];
    projectOnly: ResolvedAgent[];
  } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = () => {
    setLoadErr(null);
    return api
      .listProjectAgents(projectId)
      .then(setList)
      .catch((e: unknown) => setLoadErr((e as Error).message));
  };

  useEffect(() => {
    setList(null);
    setEditingName(null);
    setCreating(false);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 3e.3 — refresh on `project-agents-changed` so a newly committed agent
  // shows up immediately (modal closure path) AND so the section stays in sync
  // if an agent is created from the orchestrator chat side. Look at the latest
  // envelope only — the buffer in useProjectWs wraps after MAX_BUFFERED, so
  // index-based dedup isn't reliable across the wrap.
  useEffect(() => {
    const last = events[events.length - 1];
    if (last?.type === 'project-agents-changed') void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  async function resetToGlobal(name: string) {
    if (
      !window.confirm(
        `Reset "${name}" to the global version? Your local customizations will be deleted.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteProjectAgent(projectId, name);
      setEditingName(null);
      await refresh();
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }

  if (loadErr) return <p className="text-xs text-destructive">{loadErr}</p>;
  if (!list) return <p className="text-xs text-muted-foreground">Loading…</p>;

  const sections: Array<{
    title: string;
    hint: string;
    items: ResolvedAgent[];
  }> = [
    {
      title: 'Customized globals',
      hint: 'Project overrides of a global. Reset to drop the override and pick the global up again.',
      items: list.overrides,
    },
    {
      title: 'Project agents',
      hint: 'Agents authored just for this project. Edit them like any global.',
      items: list.projectOnly,
    },
    {
      title: 'Globals',
      hint: 'Shipped with PC and available in every project. Editing one creates a project override.',
      items: list.globals,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Authored conversationally. Click <span className="font-medium">+ Create Agent</span>{' '}
          to walk through an interview that produces a complete agent.
        </p>
        <button
          onClick={() => setCreating(true)}
          className="border border-border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Create Agent
        </button>
      </div>
      {creating && (
        <CreateAgentModal
          projectId={projectId}
          events={events}
          onClose={() => setCreating(false)}
        />
      )}
      {sections.map((section) => (
        <div key={section.title}>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-foreground">
              {section.title}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {section.items.length === 0 ? 'none' : `${section.items.length}`}
            </span>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">{section.hint}</p>
          {section.items.length === 0 ? null : (
            <ul className="space-y-2">
              {section.items.map((agent) => (
                <li key={`${agent.kind}-${agent.name}`} className="border border-border bg-card">
                  {editingName === agent.name ? (
                    <AgentEditor
                      projectId={projectId}
                      agent={agent}
                      onClose={() => setEditingName(null)}
                      onSaved={() => {
                        setEditingName(null);
                        void refresh();
                      }}
                    />
                  ) : (
                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <KindBadge kind={agent.kind} />
                        <span className="truncate font-mono text-xs text-foreground">
                          {agent.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {agent.kind === 'override' && (
                          <button
                            onClick={() => void resetToGlobal(agent.name)}
                            className="border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            Reset to global
                          </button>
                        )}
                        <button
                          onClick={() => setEditingName(agent.name)}
                          className="border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
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

// ─── Danger zone ─────────────────────────────────────────────────────────────

function DangerZone({
  project,
  onDeleted,
}: {
  project: Project;
  onDeleted: (projectId: string) => void;
}) {
  const [softOpen, setSoftOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesNote, setFilesNote] = useState<string | null>(null);

  return (
    <>
      <div className="space-y-4 border border-destructive/40 bg-destructive/5 p-3">
        <div>
          <div className="mb-1 text-sm font-medium text-destructive">Archive project</div>
          <p className="mb-2 text-xs text-foreground/80">
            Hides the project from the rail. Files on disk are untouched.
            Restorable from "Show archived".
          </p>
          <button
            onClick={() => setSoftOpen(true)}
            className="border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            Archive…
          </button>
        </div>

        <div className="border-t border-destructive/30 pt-3">
          <div className="mb-1 text-sm font-medium text-destructive">Delete PC files on disk</div>
          <p className="mb-2 text-xs text-foreground/80">
            Removes <code className="font-mono">.project-companion/</code> and{' '}
            <code className="font-mono">.claude/</code> from the project folder. Your own files,{' '}
            <code className="font-mono">.git/</code>, README, and <code className="font-mono">.mcp.json</code>{' '}
            stay. Independent of archive state.
          </p>
          <button
            onClick={() => {
              setFilesNote(null);
              setFilesOpen(true);
            }}
            className="border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            Delete files…
          </button>
          {filesNote && <p className="mt-2 text-xs text-success">{filesNote}</p>}
        </div>
      </div>

      {softOpen && (
        <SoftDeleteProjectModal
          project={project}
          onCancel={() => setSoftOpen(false)}
          onDeleted={(id) => {
            setSoftOpen(false);
            onDeleted(id);
          }}
        />
      )}
      {filesOpen && (
        <DeleteProjectFilesModal
          project={project}
          onCancel={() => setFilesOpen(false)}
          onDone={(removed) => {
            setFilesOpen(false);
            setFilesNote(
              removed.length === 0
                ? 'Nothing to remove — PC scaffold dirs were already gone.'
                : `Removed: ${removed.join(', ')}`,
            );
          }}
        />
      )}
    </>
  );
}

// ─── Setup wizard nag (5.6 / D82) ────────────────────────────────────────────
//
// Banner that appears in Project Settings when CLAUDE.md is missing or empty.
// Offers "Run setup wizard…" + a per-session "Dismiss" option. Clears
// automatically when the wizard finishes (project-claude-md-changed WS event)
// or when CLAUDE.md gets a non-whitespace edit on disk.

function SetupWizardNag({
  project,
  events,
}: {
  project: Project;
  events: WsEnvelope[];
}) {
  const [needs, setNeeds] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const processedRef = useRef(0);

  // Initial probe + reprobe on project switch.
  useEffect(() => {
    let cancelled = false;
    setDismissed(false);
    setNeeds(null);
    api
      .getClaudeMdStatus(project.id)
      .then((s) => {
        if (!cancelled) setNeeds(!s.exists || s.empty);
      })
      .catch(() => {
        if (!cancelled) setNeeds(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Re-probe on project-claude-md-changed.
  useEffect(() => {
    const start = events.length >= processedRef.current ? processedRef.current : 0;
    const end = events.length;
    processedRef.current = end;
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env) continue;
      if (env.type === 'project-claude-md-changed') {
        api
          .getClaudeMdStatus(project.id)
          .then((s) => setNeeds(!s.exists || s.empty))
          .catch(() => {
            /* leave stale */
          });
      }
    }
  }, [events, project.id]);

  if (needs !== true || dismissed) {
    return (
      <>
        {wizardOpen && (
          <SetupWizardModal
            projectId={project.id}
            events={events}
            onClose={() => setWizardOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
        <div className="flex-1">
          <div className="font-medium text-foreground">No CLAUDE.md yet.</div>
          <p className="text-muted-foreground">
            Future Claude sessions in this project will start blank. Run a short
            wizard to write one (you can always edit it later).
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            onClick={() => setWizardOpen(true)}
            className="bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Run setup wizard…
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="border border-border px-3 py-1 text-xs hover:bg-muted"
            title="Hide until next reload"
          >
            Dismiss
          </button>
        </div>
      </div>
      {wizardOpen && (
        <SetupWizardModal
          projectId={project.id}
          events={events}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </>
  );
}

// ─── Layout helpers ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
      {help && <div className="text-xs text-muted-foreground">{help}</div>}
    </div>
  );
}
