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

import { useEffect, useState } from 'react';

import { api, type AgentEntry, type Project } from '@/api/client';

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

        <Section title="Agents">
          <AgentsSection projectId={project.id} />
        </Section>

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

function AgentsSection({ projectId }: { projectId: string }) {
  const [library, setLibrary] = useState<AgentEntry[] | null>(null);
  const [projectAgents, setProjectAgents] = useState<AgentEntry[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [pickerName, setPickerName] = useState('');

  useEffect(() => {
    setLibrary(null);
    setProjectAgents(null);
    setLoadErr(null);
    setEditingName(null);
    setPickerName('');
    Promise.all([api.listAgents(), api.listProjectAgents(projectId)])
      .then(([lib, pa]) => {
        setLibrary(lib);
        setProjectAgents(pa);
      })
      .catch((e: unknown) => setLoadErr((e as Error).message));
  }, [projectId]);

  async function addFromLibrary() {
    if (!pickerName || addBusy) return;
    setAddBusy(true);
    setAddErr(null);
    try {
      const added = await api.addAgentFromLibrary(projectId, pickerName);
      setProjectAgents((prev) => (prev ? [...prev, added].sort(byName) : [added]));
      setPickerName('');
    } catch (e) {
      setAddErr((e as Error).message);
    } finally {
      setAddBusy(false);
    }
  }

  if (loadErr) return <p className="text-xs text-destructive">{loadErr}</p>;
  if (!library || !projectAgents) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }

  const projectNames = new Set(projectAgents.map((a) => a.name));
  const addable = library.filter((a) => !projectNames.has(a.name));

  return (
    <div className="space-y-3">
      {projectAgents.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No agents in this project yet. Add one from the library below.
        </p>
      )}
      <ul className="space-y-2">
        {projectAgents.map((agent) => (
          <li key={agent.name} className="border border-border bg-card">
            {editingName === agent.name ? (
              <AgentEditor
                projectId={projectId}
                agent={agent}
                libraryHas={library.some((l) => l.name === agent.name)}
                onClose={() => setEditingName(null)}
                onAgentSaved={(next) =>
                  setProjectAgents((prev) =>
                    prev ? prev.map((a) => (a.name === next.name ? next : a)) : prev,
                  )
                }
                onLibrarySaved={(next) =>
                  setLibrary((prev) => (prev ? [...prev, next].sort(byName) : [next]))
                }
              />
            ) : (
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate font-mono text-xs text-foreground">{agent.name}</span>
                <button
                  onClick={() => setEditingName(agent.name)}
                  className="border border-border px-2 py-1 text-xs hover:bg-muted"
                >
                  Edit
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="border-t border-border pt-3">
        <div className="mb-1 text-xs text-muted-foreground">Add from library</div>
        {addable.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            All library agents are already in this project.
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={pickerName}
              onChange={(e) => setPickerName(e.target.value)}
              className="flex-1 border border-border bg-background px-2 py-1 text-xs"
            >
              <option value="">Select an agent…</option>
              {addable.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              onClick={addFromLibrary}
              disabled={!pickerName || addBusy}
              className="bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {addBusy ? 'Adding…' : 'Add'}
            </button>
          </div>
        )}
        {addErr && <p className="mt-1 text-xs text-destructive">{addErr}</p>}
      </div>
    </div>
  );
}

function AgentEditor({
  projectId,
  agent,
  libraryHas,
  onClose,
  onAgentSaved,
  onLibrarySaved,
}: {
  projectId: string;
  agent: AgentEntry;
  libraryHas: boolean;
  onClose: () => void;
  onAgentSaved: (next: AgentEntry) => void;
  onLibrarySaved: (next: AgentEntry) => void;
}) {
  const [body, setBody] = useState(agent.body);
  const [libraryName, setLibraryName] = useState(`${agent.name}-edited`);
  const [busy, setBusy] = useState<'save' | 'library' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const dirty = body !== agent.body;

  async function save() {
    if (busy) return;
    setBusy('save');
    setErr(null);
    setSavedNote(null);
    try {
      const next = await api.updateProjectAgent(projectId, agent.name, body);
      onAgentSaved(next);
      setSavedNote('Project copy updated.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveToLibrary() {
    if (busy) return;
    const name = libraryName.trim();
    if (!name) {
      setErr('library name required');
      return;
    }
    setBusy('library');
    setErr(null);
    setSavedNote(null);
    try {
      const created = await api.createLibraryAgent(name, body);
      onLibrarySaved(created);
      setSavedNote(`Saved to library as "${created.name}".`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-xs text-foreground">{agent.name}</span>
        <button
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={14}
        className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={busy !== null || !dirty}
          className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy === 'save' ? 'Saving…' : 'Save project copy'}
        </button>
      </div>
      <div className="mt-3 border-t border-border pt-2">
        <div className="mb-1 text-xs text-muted-foreground">
          Save edits to the library as a new agent
          {libraryHas && (
            <span className="ml-1 text-foreground/70">
              (the library already has "{agent.name}" — pick a different name)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={libraryName}
            onChange={(e) => setLibraryName(e.target.value)}
            placeholder="new-library-agent"
            className="flex-1 border border-border bg-background px-2 py-1 font-mono text-xs"
          />
          <button
            onClick={saveToLibrary}
            disabled={busy !== null || !libraryName.trim()}
            className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            {busy === 'library' ? 'Saving…' : 'Save as new library agent'}
          </button>
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
      {savedNote && <p className="mt-2 text-xs text-success">{savedNote}</p>}
    </div>
  );
}

function byName(a: AgentEntry, b: AgentEntry): number {
  return a.name.localeCompare(b.name);
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
