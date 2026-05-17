# Chat interface buildout

Plan for closing the parity gap between PC's chat surface and Claude Code CLI's interactive mode. Tracks every locked decision from the 2026-05-17 audit session, the ordered build phases, and the still-to-investigate items deferred for later.

**Pointed to from `BUILDOUT.md` top.** Cold-readable: anyone picking this up should be able to start at phase 1 without re-reading the discussion that produced it.

## Why this exists

The bug that surfaced phase 2 hardening was "the chat panel shows replayed history that Claude doesn't see." That's fixed (per-session events.jsonl + session continuity). The next-level question is "does our chat surface match what a user would see in `claude.exe` interactively?" Per the audit, the answer is no — we capture the user prompt + final assistant turn + a handful of structured events, while the CLI exposes tool args/results, file diffs, slash commands, attachments, cost/model display, etc.

The phase-2 directive applies here: harden the existing surface to demo-ready (daily-driver bar) before adding features. This doc IS phase 2 for the chat tab.

## Locked decisions

Locked in conversation 2026-05-17. Don't relitigate without explicit re-discussion.

### Spawn-level

- **Always `--dangerously-skip-permissions`** on the orchestrator. No exceptions, no permission prompts in the UI.
- **Always `--model opus`** on the orchestrator. Subagents pick their own model via their YAML.

### Streaming + progress feedback

- **No token-streaming.** Assistant text drops in as one bubble on Stop. Streaming infra (tail Claude's JSONL / parse PTY raw bytes) skipped — neither is clean enough to justify.
- **In-progress feedback instead:**
  - Thinking indicator that flips on at turn-start and off at Stop. Renders the existing `state: 'thinking'` WS event we currently drop.
  - Elapsed-time counter next to the thinking indicator (long turns feel less stuck).
  - Tool calls appear live as they fire (collapsed by default).

### Chat bubble layout

- **Per-bubble role label** above each message ("User" / "Claude"). Chip or small header style.
- **User bubble gets a subtle filled background tint** — not just the border outline we have today. Differentiates from Claude visually at a glance.
- **Copy-to-clipboard button** on each bubble (user, assistant, tool output, subagent result). Show on hover; persistent on touch.

### Tool calls

- **Multi-level collapsible hierarchy:**
  - Level 1: a single "Tool calls" group per turn (collapsed by default)
  - Level 2: collapse by tool type — `Read`, `Write`, `Edit`, `Bash`, etc.
  - Level 3: individual call details (input args + result)
- **Expand/Collapse-All button at each tier** — inline at the group header.
- **Stop suppressing `tool-end` entirely.** Today we drop it (Orchestrator.tsx:350 "legacy parity: quiet"). Need it for the level-3 details.
- **Edit / Write / NotebookEdit calls auto-expand** to show a diff (high-stakes; user shouldn't have to click to see what changed).
- **Subagent dispatch (`Task`/`Agent`)** stays as its own dedicated card — NOT inside the tool-calls group. Plus live output streaming (see "Subagents" below).

### Subagents

- While a subagent is running, its tool calls stream **into the Activity panel** (not into the chat).
- The activity-panel row for that subagent dispatch is **clickable** — opens a detail view showing the full tool-call sequence + result.
- The chat-side `task-start` / `task-end` cards stay as they are (high-level summary).

### Status bar

- **Bottom status bar** in the chat panel showing:
  - Current model (`opus`)
  - Token count + cost for the active session
  - MCP status pill (alive / N tools) — clickable to open a detail panel listing connected MCP servers + their tools
  - Optional: cwd of the project

### Attachments

- **Upload to disk + reference**, not inline base64.
- New endpoint: `POST /api/projects/:id/attachments` accepts multipart, writes to `<dataPath>/sessions/<sessionId>/attachments/<filename>`, returns the path.
- The composer paste/drop handler hits this endpoint, then references the file in the next user message (path-based, similar to how a user would type a path).
- File lifecycle: attachments live with the session, deleted when the session is hard-deleted (TBD on whether we expose a per-session "delete attachments" action).

### AskUserQuestion + Ask cards

- **Fix the multi-question off-by-N bug** at `Orchestrator.tsx:695` — render ALL questions, not just `[0]`.
- Cancel still sends `__cancelled__` (Session M finding, unchanged).

### Prompt input (composer)

- **Up/Down arrow prompt history.** Trivial to add, big quality-of-life win.
- **`#` prefix shortcut** for memory-add (paired with `/memory` panel — see slash commands).

### Won't-do (intentional divergence — NOT gaps)

- `/clear` — "New session" is our equivalent
- `/resume` — Sessions tab in left rail is our equivalent
- `/exit` — close the tab
- `/config` — App Settings owns this
- `/status` — bottom status bar makes this always-visible
- Ctrl+C-twice-to-exit — close the tab
- Plan mode — disabled at the hook (`ask-intercept.cjs`)
- Vim mode for composer — we use a textarea, no demand
- IDE integration (`--ide`) — we're IDE-adjacent
- Permission prompts (Allow once / Allow always / Deny) — we always skip permissions per the locked decision above
- Token streaming — see "Streaming" above
- File-path-as-link → IDE — deferred to later

## Slash commands

Trigger: typing `/` at the start of an empty composer opens an inline picker with autocomplete. CLI muscle memory.

Pass-through commands render NO user bubble — they go to claude.exe; the result renders as an assistant turn.

### Built-in claude.exe commands

| Command | Treatment |
|---|---|
| `/help` | Pass-through |
| `/clear` | Skip (have "New session") |
| `/compact` | Skip (won't use) |
| `/memory` | **PC-native panel.** Real markdown editor for CLAUDE.md files. CLI opens `$EDITOR` which doesn't translate. |
| `/init` | Skip in chat. Project setup wizard is a separate item on the project map. |
| `/agents` | **PC-native.** Jumps to Project Settings (agent management already exists there). |
| `/mcp` | **PC-native.** Status bar pill (always-visible); click to open detail panel listing connected servers + tools. |
| `/skill` | Pass-through |
| `/model` | Skip (orchestrator is always opus per locked decision; agents pick own model) |
| `/resume` | Skip (Sessions tab) |
| `/exit` | Skip (close tab) |
| `/config` | Skip (App Settings) |
| `/status` | Skip (status bar) |
| `/loop` | Pass-through |
| `/schedule` | Pass-through |
| `/review` | Pass-through |
| `/security-review` | Pass-through |
| `/vim` | Skip |
| `/doctor` | Pass-through |
| `/upgrade` | Skip (not our concern) |

### Custom commands (`.claude/commands/*.md`)

Supported. Discover from project's `.claude/commands/` AND user-level `~/.claude/commands/`, surface in the picker, the picked one sends its markdown body as the prompt. Same shape as CLI.

### PC-native nav commands

Don't exist in CLI; add for keyboard navigation:

| Command | Action |
|---|---|
| `/sessions` | Switch left rail to Sessions tab |
| `/workflows` | Switch center tab to Workflows |
| `/work-items` (alias `/wi`) | Switch center tab to Kanban |
| `/settings` | Open Project Settings tab |
| `/app-settings` | Open App Settings modal |

## Build phases (ordered)

Order by user-visible impact per hour of work, not raw difficulty.

### Phase 1 — cheap wins (rendering the events we already capture)

These all use signals we currently drop. Minimal new infra.

1. **Thinking indicator + elapsed timer.** Render `state: 'thinking'` from WS; tick a counter from turn-start to Stop.
2. **Live tool-call rendering** with the multi-level collapse hierarchy (Level 1 "Tool calls" group → Level 2 by tool type → Level 3 individual). Stop suppressing `tool-end`. Edit/Write/NotebookEdit auto-expand with diff.
3. **Per-bubble role labels** ("User" / "Claude") above each message.
4. **User bubble background tint.**
5. **Copy button on each bubble** (hover, persistent on touch).
6. **Fix AskUserQuestion multi-question off-by-N bug.**
7. **Always `--model opus` on orchestrator spawn.** One-line change in PtySession args.
8. **Prompt history (Up/Down).** Per-project, persisted in localStorage.

### Phase 2 — status bar + MCP visibility

9. **Bottom status bar** with model + token/cost + MCP-status pill + cwd.
10. **MCP detail panel** opened by the status bar pill click. Lists connected servers + their tools. Backs onto `/api/mcp-status`.

### Phase 3 — slash commands (pass-through layer first)

11. **Slash trigger + picker** infra: `/` at the start of an empty composer opens an inline picker with autocomplete.
12. **Pass-through commands** wired (the easy half — just forward to claude.exe, no special rendering).
13. **Custom commands discovery** from `.claude/commands/*.md` (project + user). Surfaced in the picker. Picked one sends its body as a prompt.
14. **PC-native nav commands** (`/sessions`, `/workflows`, etc.).

### Phase 4 — attachments + memory editor

15. **Attachment upload endpoint** + composer paste/drop handler + reference-by-path in user message.
16. **`/memory` PC-native panel** — markdown editor for CLAUDE.md at user + project + per-folder scopes.
17. **`#` memory-add shortcut** in composer — quick-add a line to CLAUDE.md without opening the editor.

### Phase 5 — subagent live output

18. **Subagent tool calls stream to Activity panel** while the subagent runs (not just task-start/task-end in chat).
19. **Click-into-card detail view** on the activity-panel row for a subagent dispatch — shows the full tool-call sequence + result.

## Still to investigate (deferred — tackle after the phases above)

These were surfaced during the audit conversation but not walked through. Need dedicated discussion before they become buildable.

- **System message surface.** What does the CLI surface in terms of system-reminders, env-context injection, custom system prompt, error messages, "context window full" warnings, etc. What of this should we expose, suppress, or replace.
- **Full CLI reference walkthrough.** Authoritative source: <https://code.claude.com/docs/en/cli-reference>. Cover:
  - CLI flags we don't use (we only touch ~5 of dozens)
  - Subcommands: `claude agents`, `claude auth`, `claude mcp`, `claude project`, `claude plugin`, etc.
  - Environment variables
  - settings.json schema
  - IDE integration surface

## Items punted to other plans

Captured so they don't get lost — but they don't belong in the chat doc.

- **Project setup wizard.** When creating a new project, prompt the user through filling in CLAUDE.md (purpose, conventions, stack, etc.). Goes on the **project map / NEXT-SESSION.md** backlog under project lifecycle, not here.

## What this doc does NOT cover

- Workflow builder UI (Session R territory)
- Anything in the Activity panel beyond the subagent-stream extension above
- Anything in the Sessions rail tab beyond what shipped 2026-05-17
- Per-session events file migration of the user's existing pre-plumbing project-wide events.jsonl (won't do — the cosmetic glitch is one-time)

## Cold-read recovery

If you're picking this up after a `/clear`:

1. Read `CLAUDE.md` (project rules) → `NEXT-SESSION.md` (phase 2 directive) → this doc.
2. The most recent BUILDOUT.md session-log entry has the session-continuity context that produced this doc.
3. Start at Phase 1 unless the user redirects. Phases are ordered for a reason.
4. The "Locked decisions" section is canonical. Don't relitigate without explicit re-discussion.
