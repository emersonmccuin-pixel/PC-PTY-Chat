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
import { useProjectSettingsFocus } from '@/store/project-settings-focus';
import { AgentEditor } from './project-settings/AgentEditor';
import { FieldSchemasEditor } from './project-settings/FieldSchemasEditor';
import { StagesEditor } from './project-settings/StagesEditor';

interface ProjectSettingsPanelProps {
  project: Project;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
}

export function ProjectSettingsPanel({
  project,
  onProjectUpdated,
  onProjectDeleted,
}: ProjectSettingsPanelProps) {
  const agentsRef = useRef<HTMLDivElement | null>(null);
  const focusTarget = useProjectSettingsFocus((s) => s.target);
  const clearFocus = useProjectSettingsFocus((s) => s.setTarget);

  useEffect(() => {
    if (focusTarget === 'agents' && agentsRef.current) {
      agentsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      clearFocus(null);
    }
  }, [focusTarget, clearFocus]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-2xl space-y-6 p-6 text-sm">
        <header>
          <h1 className="text-lg font-semibold uppercase tracking-wider text-foreground">
            {project.name}
          </h1>
          <p className="text-xs text-muted-foreground">Project settings</p>
        </header>

        <Section title="Project info">
          <ProjectInfoForm project={project} onSaved={onProjectUpdated} />
        </Section>

        <Section title="Stages">
          <StagesEditor project={project} onProjectUpdated={onProjectUpdated} />
        </Section>

        <Section title="Field schemas">
          <FieldSchemasEditor projectId={project.id} />
        </Section>

        <div ref={agentsRef}>
          <Section title="Agents">
            <AgentsSection projectId={project.id} />
          </Section>
        </div>

        <Section title="Danger zone">
          <DangerZone project={project} onDeleted={onProjectDeleted} />
        </Section>
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
      <Field label="Name">
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

function AgentsSection({ projectId }: { projectId: string }) {
  const [list, setList] = useState<{
    globals: ResolvedAgent[];
    overrides: ResolvedAgent[];
    projectOnly: ResolvedAgent[];
  } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);

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
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
  const [confirmSoft, setConfirmSoft] = useState(false);
  const [confirmFiles, setConfirmFiles] = useState(false);
  const [softBusy, setSoftBusy] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filesNote, setFilesNote] = useState<string | null>(null);

  async function softDelete() {
    if (softBusy) return;
    setSoftBusy(true);
    setErr(null);
    try {
      await api.softDeleteProject(project.id);
      onDeleted(project.id);
    } catch (e) {
      setErr((e as Error).message);
      setSoftBusy(false);
    }
  }

  async function deleteFiles() {
    if (filesBusy) return;
    setFilesBusy(true);
    setErr(null);
    setFilesNote(null);
    try {
      const removed = await api.deleteProjectFiles(project.id);
      setFilesNote(
        removed.length === 0
          ? 'Nothing to remove — PC scaffold dirs are already gone.'
          : `Removed: ${removed.join(', ')}`,
      );
      setConfirmFiles(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setFilesBusy(false);
    }
  }

  return (
    <div className="space-y-4 border border-destructive/40 bg-destructive/5 p-3">
      <div>
        <div className="mb-1 text-sm font-medium text-destructive">Soft-delete project</div>
        <p className="mb-2 text-xs text-foreground/80">
          Hides the project from the rail. Files on disk are untouched.
        </p>
        {confirmSoft ? (
          <div className="flex items-center gap-2">
            <button
              onClick={softDelete}
              disabled={softBusy}
              className="bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {softBusy ? 'Deleting…' : 'Confirm soft-delete'}
            </button>
            <button
              onClick={() => setConfirmSoft(false)}
              disabled={softBusy}
              className="border border-border px-3 py-1 text-xs hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmSoft(true)}
            className="border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            Soft-delete…
          </button>
        )}
      </div>

      <div className="border-t border-destructive/30 pt-3">
        <div className="mb-1 text-sm font-medium text-destructive">Delete PC files on disk</div>
        <p className="mb-2 text-xs text-foreground/80">
          Removes <code className="font-mono">.project-companion/</code> and{' '}
          <code className="font-mono">.claude/</code> from the project folder. Your own files,{' '}
          <code className="font-mono">.git/</code>, README, and <code className="font-mono">.mcp.json</code>{' '}
          stay. Independent of soft-delete.
        </p>
        {confirmFiles ? (
          <div className="flex items-center gap-2">
            <button
              onClick={deleteFiles}
              disabled={filesBusy}
              className="bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {filesBusy ? 'Removing…' : 'Confirm delete files'}
            </button>
            <button
              onClick={() => setConfirmFiles(false)}
              disabled={filesBusy}
              className="border border-border px-3 py-1 text-xs hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmFiles(true)}
            className="border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            Delete files…
          </button>
        )}
        {filesNote && <p className="mt-2 text-xs text-success">{filesNote}</p>}
      </div>

      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
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
