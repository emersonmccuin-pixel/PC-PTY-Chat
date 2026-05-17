# Multi-Tenancy Design

Locked-design doc for PC's multi-project shape. Produced in Session O (2026-05-16, planning-only). Implementation lands in Session P (server) + Session Q (UI vendor).

Read this before touching `apps/server/src/services/`, the channel server, the worktree service, or anything that creates / destroys projects.

## Core stance (locked during Session N close-out)

- **Multi-project is core, not a deferred chassis item.** Project picker is fully functional from day one.
- **Every project is git-backed.** No exceptions. Folder picker at create time; if the folder isn't a repo we set one up.
- **Every project is folder-linked.** PC stores a `folder_path` per project. The user's actual code lives there; PC's per-project state lives in `<folder>/.project-companion/` inside it.
- **Per-project everything:** PtySession (orchestrator), workflow registry, channel routes, `.claude/agents/` copies, worktrees namespace, settings.
- **Optional git remote** at creation; editable later in project settings. Not required to use PC.

## Locked answers (7 questions from Session N log)

### 1. Default projects folder = `~/Projects/`

Familiar; matches every dev tool's default. Settable in app settings as `projectsFolder` global.

Not `~/.project-companion/projects/` — that conflates the user's real repos with PC's data dir; awkward when users open their project in an IDE and find it inside a hidden app-data path.

### 2. Existing folder with files but no `.git` → ask, init-in-place as default

Create-project flow probes the target folder. If it has files but no `.git`:

- Show the user: file count + a one-screen plan ("Init git here, commit existing files as `Initial import`, then add `.project-companion/` scaffold as a second commit.").
- "Proceed" is the default button. "Cancel" available.
- Two commits, not one: `Initial import` of pre-existing files, then `Add Project Companion scaffold`. Lets the user `git diff` to see exactly what PC added.

Refusing is unhelpful. Silently initing is destructive-feeling. Asking once is the right cost.

### 3. Channel topology = multiplexed, single server, path-routed

- One channel server on `:8788` (same port as today).
- Routes: `POST /channel/<project-slug>/<source>` — e.g. `POST /channel/my-app/webhook`.
- Event payload carries `projectId`; WS broadcasts include `projectId` so the UI routes events to the right project's chat panel.
- `pc_log` MCP tool is project-scoped (the per-project orchestrator's MCP config injects the project's id).

Rejected: per-project ports (8788, 8789, …). Operational drag (port allocation, collision risk, webhook URLs changing on port reuse) outweighs the isolation upside for a local-first single-user app.

### 4. Worktrees layout = trunk-level under data dir

`<data_dir>/worktrees/<project-slug>/<work-item-id>/`

Run-triggered worktrees: `<data_dir>/worktrees/<project-slug>/run-<short>/`.

Matches v1 architecture §4. Keeps the user's actual repo clean — no `.worktrees/` dir in their `git status`, no IDE noise, no gitignore dance. PC's noise stays in PC's data dir.

### 5. Agents = library template pool + per-project copies that diverge

```
~/.project-companion/
  agents/                 # global library (templates pool)
    researcher.md
    reviewer.md
    qa.md
    ...

<project-folder>/
  .claude/agents/         # per-project copies — LIVE (used by claude.exe)
    researcher.md         # diverged via project-local edits
    reviewer.md           # still matches library
```

- PC ships canonical templates under trunk-repo `templates/.claude/agents/`; bootstraps `~/.project-companion/agents/` from them on first run if missing.
- Project create copies the user's selected agents (default = all) from the library into `<project>/.claude/agents/`.
- Editing an agent inside a project edits the project copy only — the library version is untouched.
- UI affordances (Session Q): "Add agent from library" picker per-project; "Save as new library agent" when authoring inside a project.
- Project's copy is the live file `claude.exe` loads from cwd. No symlinks (cross-OS pain).
- Per-project agents are committed inside the project's repo as a normal part of its scaffold.

Rejected: shared trunk-level single-source-of-truth. One breaking edit nukes every project's agents; no per-project specialization (Rails-aware vs React-aware researcher).

Followup: a "push my project edits back to the library" affordance is plausible later. Not in the first cut.

### 6. First commit on project create = always seed scaffold + README

**Fresh folder** (newly created or empty):
- One commit, `Initial commit`, contains `.project-companion/{workflows}/`, `.claude/agents/` (library copies), `README.md`.

**Existing folder with files** (after the Q2 confirmation):
- Commit 1: `Initial import` of pre-existing files.
- Commit 2: `Add Project Companion scaffold`.

Rejected: empty repo / unborn HEAD. Worktrees against an unborn branch are fragile; the first user action becomes "why is git weird."

Rejected: scaffold-but-don't-commit. Surprises users who expect "PC initialized my repo" to leave a committed initial state.

### 7. Existing `rig` project on first multi-tenant boot = wipe

The `workspace/` rig was Session A-N scaffolding — a fixed, single-tenant fixture path. Multi-tenancy is a new contract.

On Session P bootstrap:
- The hardcoded `rig` seed in `apps/server/src/index.ts` is removed.
- First boot opens with zero projects.
- User creates their first project via the UI's project picker (lands in Session Q).
- Existing sqlite state from Session M (smoke-test work items, runs) does not survive — the project row that bound them is gone.

Rejected: migrate the rig into the multi-tenant shape. Migration code is complexity for a single-user state the user can recreate in 30 seconds. Per-project worktrees / channel routes / agent copies are new shape — migrating in-place leaves the rig project half-old, half-new.

Rejected: keep rig as-is + add multi-tenancy alongside. Two parallel systems; dead code stays in the runtime; we never validate the new shape on a clean slate.

## Implementation notes that fall out

### Data shape

- `projects.folder_path: string` (absolute, OS-native separator).
- `projects.git_remote: string | null` (origin URL; null = no remote, local-only).
- `projects.created_at: number` (epoch ms, per v1 decision #15).
- `projects.deleted_at: number | null` (soft-delete, per v1 decision #16).
- `projects.slug` stays the routing key for URLs (channel routes, worktree paths). ULID is the primary key. Slug is derived from name + uniqued at create time; user-editable in project settings (worktree dir + channel URLs would migrate on rename — followup; out of first cut).

### Per-project filesystem layout

```
<project-folder>/                                 # user-picked, git repo
├── .git/
├── .claude/
│   ├── agents/                                   # library copies, diverge on edit
│   │   └── *.md
│   ├── hooks/                                    # copied from trunk templates at create
│   │   └── *.cjs
│   └── settings.json                             # generated per-project
├── .mcp.json                                     # generated per-project (PC's MCP server URL + project-id header)
├── .project-companion/
│   ├── workflows/                                # YAML, registry watches this dir
│   │   └── *.yaml
│   └── CLAUDE.md                                 # orchestrator system instructions
├── README.md                                     # seeded at create
└── <user's own files>
```

### Trunk templates (PC repo)

```
<pc-repo>/
└── templates/
    ├── .claude/
    │   ├── agents/                               # canonical agent .md files
    │   ├── hooks/                                # canonical hook .cjs files
    │   └── settings.template.json
    ├── .mcp.template.json
    ├── .project-companion/
    │   ├── workflows/                            # canonical seed workflows
    │   └── CLAUDE.md
    └── README.template.md
```

Bootstrap: on server start, if `~/.project-companion/agents/` is empty / missing, copy from `templates/.claude/agents/`. Same pattern for any other library-pool dirs we add later.

Project create scaffolding: write each `templates/*` entry into `<project-folder>/` with per-project tokens substituted (project name, project id, etc.).

### ProjectRuntime abstraction

Today `apps/server/src/index.ts` holds a singleton `WorkflowRuntime`, singleton `PtySession`, singleton channel state. Session P introduces:

```ts
class ProjectRuntime {
  constructor(public projectId: ULID, public folderPath: string) {}
  pty: PtySession;
  workflows: WorkflowRuntime;
  worktrees: WorktreeService;
  // channel routing pulled out into shared multiplexed server
}

class ProjectRegistry {
  private runtimes = new Map<ULID, ProjectRuntime>();
  ensure(projectId: ULID): ProjectRuntime { ... }
  shutdown(projectId: ULID): Promise<void> { ... }
}
```

PtySession's cwd is the project's `folder_path`. The `--mcp-config` flag points at `<folder>/.mcp.json` (generated). Hooks read `<folder>/.claude/hooks/*.cjs`.

### Channel server

Single instance, multiplexed by URL path. Internal POSTs from MCP / server keep `X-Sender: test` header. WS broadcasts:

```ts
type ChannelEvent = {
  projectId: ULID;
  source: string;       // 'webhook', 'workflow', etc.
  payload: unknown;
  at: number;
};
```

Client subscribes to all events; UI routes by `projectId` matching the active project.

### Worktree service

Keyed by project. Method signature changes:

```ts
ensureWorktree(projectId: ULID, name: string): Promise<string>
// returns: <data_dir>/worktrees/<project-slug>/<name>/
```

Slug resolution: cache `projectId → slug` lookup at registry boot; refresh on rename.

### MCP tool surface

Tools become project-scoped via the `X-PC-Project` header (or path-segment) injected into the per-project `.mcp.json`. Tools see `req.context.projectId` and route to the right `ProjectRuntime`. Names unchanged (`pc_log`, `pc_create_work_item`, etc.).

### Soft-delete + filesystem

`DELETE /api/projects/:id` sets `deleted_at`. Filesystem (the user's folder, their `.git`, their `.project-companion/`) is left untouched by default. A separate explicit "Also delete files on disk" action (project settings → danger zone) is the only path to filesystem removal — and even then, only `.project-companion/` and `.claude/` are PC's to delete; the user's own files stay.

## Open / deferred

- **Project rename → slug migration.** Worktree dirs (`<data_dir>/worktrees/<slug>/`) and channel routes (`/channel/<slug>/`) embed the slug. Renaming requires either keeping the old slug, or moving worktree dirs + invalidating webhook URLs. First cut: name is renamable, slug is locked at create time. Followup.
- **"Push project edits to library" affordance for agents.** Out of first cut.
- **Per-project concurrency caps** (v1 §8 override matrix says project may lower below global). Defer until concurrency caps are a thing in PC v2 at all.
- **Isolation environments** (v1 §M9). Out of scope; flagged in Session N log as "skip on UI for first cut."
- **File attachments** (v1 §4 `attachments` table). Out of scope; same reason.
- **Vault / secrets** (v1 §M11). Out of scope.
- **Activity panel scope toggle** (v1 §7: active-project-default + "all projects" toggle). UI surface for Session Q; backend already has it implicitly (events are flat with `projectId` tags).
