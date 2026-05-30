# Foundation Specs

This folder holds concise, build-oriented specs that resolve cross-system decisions before implementation begins.

Read first:

1. `../target-architecture.md`
2. `../holistic-architecture-synthesis.md`
3. `../refactor-tracker.md`

Planned specs:

1. `shared-contracts-and-app-services.md`
2. `live-events-and-outbox.md`
3. `mailbox-and-pending-interactions.md`
4. `runtime-transcript-and-conversation-store.md`

Each spec should include:

- decisions needed before build;
- verified current-state evidence;
- proposed contracts and ownership;
- migration phases;
- compatibility and rollback notes;
- acceptance criteria;
- tests;
- open questions.

Keep specs practical. Do not re-audit whole subsystems here.

