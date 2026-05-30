# Pickup Protocol

Purpose: make a fresh Codex session resume project work from a handoff file with
predictable branch, verification, commit, and merge behavior.

## Worktree Rule

Codex pickup work must happen in a Codex-owned worktree, not the primary
checkout.

Primary checkout:

```text
E:\Claude Code Projects\Personal\PC-PTY-Chat
```

Default Codex worktree:

```text
E:\Claude Code Projects\Personal\PC-PTY-Chat-codex
```

At session start:

1. Run `git worktree list --porcelain`.
2. If the Codex worktree exists, work there.
3. If you are in the primary checkout and the Codex worktree does not exist,
   create it:

```powershell
git worktree add -b codex/architecture-refactor "E:\Claude Code Projects\Personal\PC-PTY-Chat-codex" feature/architecture-refactor
```

4. Do not switch branches, merge, rebase, reset, clean, or edit files in the
   primary checkout.
5. Do not remove or prune worktrees unless the user explicitly asks.

## Trigger

When the user says:

```text
pickup <branch-or-label> <handoff-file>
```

do this protocol. The preferred form is:

```text
pickup feature/architecture-refactor docs/refactor-session-handoff-2026-05-28.md
```

If no branch is explicit, use `codex/architecture-refactor` in the Codex
worktree, based on `feature/architecture-refactor`. Treat the file path as
relative to the repo root unless it is absolute. If the path is vague, find it
with `rg --files | rg <basename-or-keywords>`.

## Branch Rule

Do not do pickup work directly on `dev` or in the primary checkout.

1. Start with `git status --short --branch`.
2. If not already on the requested Codex branch, switch to it in the Codex
   worktree.
3. If the Codex branch does not exist, create it from the requested base branch
   or `dev`.
4. If uncommitted work exists before switching, preserve it:
   - if it belongs to the current session goal, commit it before switching;
   - otherwise switch with the dirty tree only when Git permits it, then commit
     it separately on the Codex branch before new work.
5. If the requested feature/base branch is checked out by another worktree, do
   not steal it. Create a `codex/<topic>` branch from it instead.
6. Never revert unrelated user changes.

Current default Codex working branch:

```text
codex/architecture-refactor
```

## Startup

After switching branches:

1. Read the handoff file completely.
2. If the file has a "starter prompt" or "first steps" section, follow it.
3. Run every state-check command listed by the handoff before editing.
4. If the handoff does not define checks, run at minimum:

```powershell
git status --short --branch
pnpm --filter @pc/web typecheck
```

5. State briefly what you found and continue; do not stop at a plan unless the
   handoff is ambiguous enough that a wrong assumption would be risky.

## Work And Verification

- Prefer the next smallest safe slice named by the handoff.
- Keep behavior-preserving refactors separate from behavior changes.
- Run focused typechecks/tests after each risky slice.
- Before closing, run the broader checks named by the handoff. If none are
  named, run:

```powershell
pnpm --filter @pc/web typecheck
pnpm --filter @pc/server typecheck
git diff --check
```

## Commit Rule

Everything must be committed before the final response.

- Use coherent commits, not one giant mixed commit, when the work naturally
  splits.
- Include untracked files.
- Do not leave a dirty tree for review.
- If verification forces a follow-up fix after a commit, make another commit.
- If something truly cannot be committed, explain the exact blocker and leave
  the tree as clean as possible.

## End-Of-Session Merge

Unless the user explicitly says not to merge, merge the Codex branch back to
`dev` at the end of a pickup session from inside the Codex worktree.

1. Ensure the Codex branch is clean and all work is committed.
2. Switch to `dev`.
3. Merge the Codex branch.
4. Resolve conflicts if they occur.
5. Re-run the relevant verification after conflict resolution.
6. Commit the merge if Git did not fast-forward.
7. Switch back to the Codex branch.
8. Fast-forward or merge `dev` back into the Codex branch so both branch tips
   match.
9. End with `git status --short --branch` and report the final branch state.
10. Do not update a feature/base branch that is checked out by the primary
    checkout; report that `dev` contains the merge and leave that checkout
    untouched.

If the merge produces conflicts that cannot be resolved safely, commit nothing
partial, report the conflicted files, and ask for direction.

## Handoff File Shape

Future handoff files should include:

- current branch and dirty-state expectations;
- exact startup checks;
- the next objective;
- acceptance criteria;
- verification commands;
- any files that must not be reverted;
- a starter prompt at the bottom.
