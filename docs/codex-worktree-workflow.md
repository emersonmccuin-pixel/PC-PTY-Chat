# Codex Worktree Workflow

Purpose: keep Codex file edits isolated from the primary checkout while Claude
or the user is working in the repo.

## Paths

- Primary checkout: `E:\Claude Code Projects\Personal\PC-PTY-Chat`
- Codex worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-codex`
- Default Codex branch: `codex/architecture-refactor`
- Current integration branch: `dev`
- Refactor base branch: `feature/architecture-refactor`

## Rules

- Codex edits files only in the Codex worktree.
- Treat the primary checkout as owned by Claude/the user.
- Do not switch branches, merge, rebase, reset, or clean in the primary checkout.
- Do not prune or remove worktrees unless the user explicitly asks.
- Keep the no-restart rule from `AGENTS.md` and `CLAUDE.md`.

## Session Start

From any checkout:

```powershell
git worktree list --porcelain
```

If `E:\Claude Code Projects\Personal\PC-PTY-Chat-codex` exists, work there:

```powershell
Set-Location "E:\Claude Code Projects\Personal\PC-PTY-Chat-codex"
git status --short --branch
```

If it does not exist, create it from the primary checkout:

```powershell
git worktree add -b codex/architecture-refactor "E:\Claude Code Projects\Personal\PC-PTY-Chat-codex" feature/architecture-refactor
```

Install dependencies in the Codex worktree once after creation:

```powershell
pnpm install --frozen-lockfile
```

## Branching

- Use `codex/<topic>` branches for Codex work.
- Use `codex/architecture-refactor` for ongoing architecture refactor pickup work.
- If the default Codex branch already has unrelated work, create a task branch:

```powershell
git switch -c codex/<short-task-slug>
```

## Closing

Before responding:

```powershell
pnpm --filter @pc/web typecheck
pnpm --filter @pc/server typecheck
git diff --check
git status --short --branch
```

Commit all tracked and untracked deliverables in the Codex worktree.

Unless the user says not to merge:

```powershell
git switch dev
git merge <codex-branch>
pnpm --filter @pc/web typecheck
pnpm --filter @pc/server typecheck
git diff --check
git switch <codex-branch>
git merge dev
```

Do not update branches that are checked out by the primary checkout. Report the
final `dev` and Codex branch tips instead.
