# Next session — read this first

You are picking up Project Companion v2 after Session Q closed (all 14 UI / multi-tenancy milestones shipped). Do NOT roll into Session R (workflow builder UI) or any other feature work. The user has set explicit priorities below.

## The user's directive

> Before adding or changing anything, we fix the UX of what's already here and harden it. Then we go feature by feature.

So the order is:

1. **Plan first.** Review the full plan across `BUILDOUT.md`, `MULTI-TENANCY-DESIGN.md`, `DESIGN-WORKFLOWS-V2.md`. Refine it. Surface gaps. Get user buy-in on the prioritized order before touching code.
2. **Harden second.** Work through the UX-and-stability backlog below. No new features in this phase.
3. **Features third.** Once the existing surface is polished, go feature by feature in the order the plan dictates.

The user is non-technical. They want to *see* the app behave well, not get a build-log. Demo-readiness is the success metric for phase 2.

## What's working today (don't re-discover this)

Boot: `pnpm dev` + `pnpm --filter @pc/web dev` → `http://127.0.0.1:5173/`.

- 3-column shell (project rail / center workspace / activity panel) with resizable, persisted panels.
- **Project lifecycle:** create (folder picker → empty / init-in-place), rename, edit git remote, soft-delete, danger-zone delete on-disk files.
- **Multi-tenant:** N projects in parallel, each with its own folder, git repo, agent copies, worktrees, channel routes, MCP config.
- **Work items kanban** with drag-and-drop, live sync via WebSocket.
- **Orchestrator chat** (one Claude session per project, persistent, with todos, ask/approval cards, channel-block parsing).
- **Workflows (read-only):** YAML registry view + run history + pending approvals. *No builder yet — that's Session R.*
- **App settings + per-project settings**, persisted to sqlite. Activity panel toggle + projectsFolder hot-reloadable; data-dir requires restart.
- **Agent library** at `~/.project-companion/agents/` with per-project copy-on-edit.
- **Channel server** on `:8788` — external POSTs route by project slug and wake the orchestrator.
- **WS hardening:** exponential backoff reconnect + `ts` dedup against the server's `events.jsonl` replay (Q13, verified 6→6 events across a forced kill).
- **Subagent delegation** via `Task` tool, with worktree binding and a `PreToolUse` path-guard hook blocking writes outside the bound dir.

## UX + hardening backlog (gathered this session)

Each item is something we observed but did not fix. Use this as the starter list for phase 2; expect the user to add to it once they actually drive the UI.

### Folder picker

- **No typed-path input.** `FolderBrowserModal` only supports click-drill from a starting path. Users can't paste an absolute path or jump to a known drive root quickly. Painful when picking anything outside the configured `projectsFolder`.
- **`/api/fs/browse` allowlist is homedir-scoped.** Drilling outside `~/` returns 403 unless `PC_FS_BROWSE_ALLOW` is set as an env var at server start. Surfaced by the Playwright tests needing `E:\temp\…` access. UX implication: power users on Windows with content on D:/E:/ drives hit a wall. Decide: typed-path escape hatch, runtime allowlist editing via App Settings, or just relax the constraint behind a flag.

### Rail / activity widths

- Default + min sizes were just tuned (`fa222fa`) but only loosely tested. Worth deliberate review at 1280px, 1440px, ultrawide.
- `react-resizable-panels` v4 size props: numbers are PIXELS, strings are PERCENTAGES. See header comment in `apps/web/src/components/Shell.tsx`. Easy regression trap.

### Activity panel

- Rows still rely on `truncate`; long messages are only readable via the `title=` hover added in `fa222fa`. On a narrow panel that's most rows. Consider a "wrap when expanded" mode, an explicit detail drawer on row click, or a horizontal scroll with sticky columns.
- "All projects" toggle persists via `settings.activityPanel.showAllProjects`. Multi-project subscribe opens N parallel WebSockets; CPU/memory profile under heavy event load not yet measured.
- Hide-panel state lives in `settings.activityPanel.open`. There is no way to *re-show* the panel except from the top-right header chevron. Discoverable enough?

### Kanban

- Columns are now flex-1 with `min-w-[14rem]` and a `data-stage-id` attribute. Many stages still scroll horizontally — verify the scroll affordance is obvious (no edge fade / arrow today).
- Cards: only the title shows. No card detail panel exists; clicking a card does nothing. Decide whether that's MVP-enough or a phase-2 must.
- Status field on cards isn't rendered in the UI even though `WorkItem.status` exists on the wire.

### Orchestrator chat

- Composer is Enter-to-send / Shift+Enter newline; OK for power users. No history navigation, no slash-command palette.
- Long markdown messages with code blocks: width is constrained by center pane minus padding. Test horizontal-scrollable code blocks at narrow widths.
- Interrupt button sends `type:'interrupt'` to the WS. No visual confirmation of "interrupt delivered." Worth a transient toast.
- Ask cards: Cancel sends `__cancelled__` per a Session M finding. Verify the orchestrator handles that gracefully and the UI reflects the cancel state clearly.
- **"Reload session" action.** `claude.exe` reads `.mcp.json`, `.claude/settings.json`, and `.claude/agents/*.md` at spawn time only — editing them mid-session is a no-op until the PTY respawns. Today the only respawn paths are "New session" (loses chat) or a server restart (sledgehammer; all projects). Add a per-project reload that kills the PTY and respawns with `--resume <uuid>` — same chat, new process picks up new config. Right-click menu item alongside "New session". Plumbing is mostly there: same shape as `startNewSession` minus the wipe + new-UUID parts.

### Project settings

- Slug is locked at creation per `MULTI-TENANCY-DESIGN.md`'s "Open / deferred." Worth surfacing *why* in the UI, not just showing it read-only.
- Agent editor is a raw `<textarea>` — no syntax highlighting on the YAML frontmatter or markdown body. Probably fine for v1.
- Danger-zone two-step confirms (`Confirm soft-delete`, `Confirm delete files`) are inline — works but a modal might be clearer for the file-removal one.

### Workflows tab

- Read-only. No way to author / edit / preview from the UI. This is Session R proper, NOT phase 2 hardening — but if anything about the *current* read-only surface is unclear (run status icons, "invalid YAML" error rendering, etc.) catch it now.

### Empty / first-run state

- Never properly tested end-to-end with a wiped DB. `BUILDOUT.md`'s user-test step 1 ("project rail shows 'no projects.'") was skipped because tests refused to wipe the live DB. Worth a deliberate fresh-DB walkthrough as part of phase 2.
- The "Create a project to get started" center hint is one line; consider a richer onboarding tile.

### Dev ergonomics (not user-facing but bites the team)

- `apps/server/dev` script now passes quoted `--ignore` globs to `tsx watch` for `data/`, `test-results/`, `playwright-report/`. Add new write-heavy paths to that list as they appear, or `tsx watch` will reload-loop.
- A `data.bak.<epoch>/` directory is sitting untracked at repo root. Untouched this session. Decide whether to gitignore, delete, or keep as a manual snapshot.

### Workflow runtime followups (from `CLAUDE.md`)

These are runtime gaps surfaced during Slice 9 but never closed. Mostly small individually. Belong in phase 2 if any of them shows up as user-visible weirdness; otherwise can ride alongside Session R:

- `when:false` short-circuit
- `run.outputs` capture
- `done_when` strict enforcement
- async loop bodies
- `$inputs.x` variable references
- terminated-workflow ping
- bundled `<channel>` event rendering

## Open questions for the planning pass

These are decisions the user needs to make before phase 2 / 3 work begins. Don't assume an answer.

1. **What does "demo-ready" mean?** First impression for whom — the user themself, a colleague, a stranger? That shapes how aggressive the polish gets.
2. **Which of the deferred features (isolation environments, file attachments, vault, agent push-to-library, project rename → slug migration, per-project concurrency caps) actually unblock the user's day-to-day use, vs. nice-to-have?**
3. **Workflow builder UI (Session R) — when?** Could be phase 2 if the read-only surface bothers the user; could be phase 3 if hand-edited YAML is fine for now.
4. **Authentication / multi-user / cloud sync** — entirely off-roadmap today, single-user / local-only. Stay that way or scope it in?
5. **Mobile / responsive UI** — single-pane mobile mode would be a real chunk of work. In or out?

## Read order for cold context

If you're a fresh agent on this codebase, read in this order before you touch anything:

1. `CLAUDE.md` — project rules + working rhythm.
2. **This file** (`NEXT-SESSION.md`) — what you're picking up and what NOT to do.
3. `BUILDOUT.md` — top section + the `### Session Q (closeout)` entry at the bottom. Skip the older mid-session entries unless you need historical context.
4. `MULTI-TENANCY-DESIGN.md` — locked design for the multi-tenant chassis. Required if you touch project lifecycle, channels, or worktrees.
5. `DESIGN-WORKFLOWS-V2.md` — active workflow runtime design. Required if you touch `apps/server/src/services/workflow-runtime.ts` or the seed workflows.
6. The v1 reference at `E:/Claude Code Projects/Personal/Project Companion/` (read-only) — useful only when you need to compare a vendor component against its original.

Skip on cold reads: `DESIGN-WORKFLOWS-AND-CONTRACTS.md`, `PLANNING-CONTRACTS-MODELS.md`, `Q14-TEST-HANDOFF.md` (specific to the just-completed test gate).

## First move for the fresh session

When the user types whatever they type to start, your opening should be roughly:

> Reviewed the plan. Here's the prioritized backlog for phase 2 (UX + hardening) and how I'd order it. Pushback / additions before I start?

i.e. don't dive in. Present the plan, get alignment, then work the list one item at a time with the user driving prioritization.
