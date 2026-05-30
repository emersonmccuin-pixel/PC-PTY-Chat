# Refactor Plan Docs

Put subsystem architecture handoff documents in this folder.

The six priority subsystem docs have been synthesized into:

```text
../holistic-architecture-synthesis.md
```

Do not put roadmap, foundation specs, test plans, or build-slice plans in this folder.

Use:

```text
../implementation-roadmap.md
../foundation specs/
../phase-0-test-characterization-plan.md
../build-slices/
```

Use this filename pattern:

```text
{subsystem-slug}.md
```

Examples:

```text
chat-runtime-and-transcript-ui.md
runtime-host-and-pty-sessions.md
work-items-stages-and-fields.md
```

After adding or updating a subsystem document, update `../refactor-tracker.md`.

For the current post-synthesis workflow, start from `../refactor-tracker.md`.
