# Pickup Protocol

Purpose: make a fresh Codex session resume project work from a handoff file with
predictable branch, verification, commit, and merge behavior.

## Trigger

When the user says:

```text
pickup <branch-or-label> <handoff-file>
```

do this protocol. The preferred form is:

```text
pickup feature/architecture-refactor docs/refactor-session-handoff-2026-05-28.md
```

If no branch is explicit, use `feature/architecture-refactor`. Treat the file
path as relative to the repo root unless it is absolute. If the path is vague,
find it with `rg --files | rg <basename-or-keywords>`.

## Branch Rule

Do not do pickup work directly on `dev`.

1. Start with `git status --short --branch`.
2. If not already on the requested feature branch, switch to it.
3. If the feature branch does not exist, create it from `dev`.
4. If uncommitted work exists before switching, preserve it:
   - if it belongs to the current session goal, commit it before switching;
   - otherwise switch with the dirty tree only when Git permits it, then commit
     it separately on the feature branch before new work.
5. Never revert unrelated user changes.

Current default working branch:

```text
feature/architecture-refactor
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

Unless the user explicitly says not to merge, merge the feature branch back to
`dev` at the end of a pickup session.

1. Ensure the feature branch is clean and all work is committed.
2. Switch to `dev`.
3. Merge the feature branch.
4. Resolve conflicts if they occur.
5. Re-run the relevant verification after conflict resolution.
6. Commit the merge if Git did not fast-forward.
7. Switch back to the feature branch.
8. Fast-forward or merge `dev` back into the feature branch so both branch tips
   match.
9. End with `git status --short --branch` and report the final branch state.

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
