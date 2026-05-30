# Session Handoff — 2026-05-28 (crash resilience, UI perf, phase-5 merge)

`dev` @ `a505476c`, pushed to origin. Working tree clean.

## What shipped this session

- **Crash diagnostics + auto-recovery** — server died with `0xC0000374` (node-pty
  native heap corruption) and the reason was vanishing. Added `apps/server/src/diagnostics.ts`
  (Node report + `server-crashes.log` under `<dataDir>/diagnostics`), supervisor log
  tee to `apps/server/.dev-logs/`, PTY lifecycle log, and supervisor **auto-respawn
  on healthy-then-crash** (capped).
- **Supervisor port-wait** — waits for 4040/8788 to free before (re)spawning, killing
  the `EADDRINUSE :8788` respawn-race bounce.
- **Crash trigger fix** — workflow agent `initialInput` kept short/single-line
  (`dag-run-service.ts`) to avoid echo-ack PTY churn.
- **Chat/terminal UI lag** — timeline windowed to last 200 (+ "Load earlier"),
  `contain:content` on the scroller, chat not rendered in terminal mode; terminal
  live-write uses an **index cursor** (was O(N²)) + **WebGL renderer** (was DOM).
- **Merged `codex/phase-5-hardening` into `dev`** — 28 commits, verified
  (typecheck/539 tests/build) before a `--ff-only` land. Backup tags:
  `backup/2026-05-28/{dev-pre-phase5-merge,phase5-pre-merge}`.

## Immediate action (user, when agents are idle)

**Restart the dev server.** The phase-5 merge landed via HMR, so the web app has the
new frontend but the running tsx server still serves the **pre-merge backend** —
FE↔BE contract changes (`align web settings contracts`, `harden dev controls
contracts`, `align workflow fire response type`) can mismatch until restart. The
restart also arms the diagnostics + port-wait fixes. NB: a restart kills running
agents (see next).

## Next focus — durable fix: out-of-process agent host

Task #7 / `docs/out-of-process-agents-todo.md`. Agents run as in-process PTY
children, so **any** server reboot (crash or intentional) kills them
(`reconcileOrphanedRunningRuns` marks them `failed`). Native crashes can't be caught
in JS. Durable fix = run agent PTYs in a separate long-lived host the API server
reattaches to on restart (re-tail JSONL, the canonical source); stop blanket-failing
runs on boot. Start by writing the host contract + reattach/reconcile design.

## Watch-outs

- Don't re-chase the chat "Maximum update depth" burst — it's a dev StrictMode
  transient (see memory), not a real loop.
- Don't restart the server/app unasked; restarts kill running agents.
- Codex worktrees (`-codex`, `-phase5`) are Codex's; don't edit/merge from the
  primary checkout without explicit ask.
