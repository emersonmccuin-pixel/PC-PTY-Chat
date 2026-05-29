# TODO — Out-of-process agent host (durable crash isolation)

Status: Phase A seams complete; Phase B host process MVP next. Owner: Codex. Logged 2026-05-28.

Design: `docs/out-of-process-agent-host-design.md`.

## Problem

Agents run as in-process PTY children (`pty.spawn` inside the server process —
`packages/runtime/src/low-level-spawn.ts`). When the server process dies, ConPTY
tears down the child `claude.exe` processes with it, and on restart
`reconcileOrphanedRunningRuns` (`packages/db/src/repos/agent-runs.ts`) marks every
`queued|spawning|running|paused` run as `failed: "server restarted before this run
completed"`.

So **any** server reboot — crash *or* intentional restart — kills all running
agents. Native crashes (node-pty `0xC0000374` heap corruption, ConPTY
`AttachConsole failed`) can't be caught in JS, so no in-process guard fully fixes
this.

## Quick fixes already shipped (mitigations, not the cure)

- Crash diagnostics + supervisor auto-respawn (`diagnostics.ts`, `dev-supervisor.mjs`).
- Short workflow `initialInput` to reduce PTY spawn/kill churn (`dag-run-service.ts`).
- Supervisor waits for ports 4040/8788 to free before (re)spawning — kills the
  `EADDRINUSE :8788` respawn-race bounce.

## Durable fix — design sketch

Run agent PTYs in a **separate, long-lived host process** the API server talks to
over IPC, so a server crash/restart leaves agents alive and the server reattaches.

Key pieces now drafted in the design:
- **Agent host process**: owns `LowLevelSpawn`/node-pty; survives API server restarts.
  Could be a sibling under the dev supervisor (and the packaged app's main process).
- **Reattach on restart**: server reconnects to the host, re-subscribes to live
  agent streams. JSONL is already the canonical source
  (see memory `reference_chat_jsonl_canonical_source`), so output can be re-tailed
  from disk even across a reconnect.
- **Run-state reconciliation**: stop blanket-failing runs on boot; only fail runs
  whose host-side PTY is genuinely gone.
- **Lifecycle/ownership**: who kills the host on real shutdown vs. restart; how the
  packaged app supervises it.
- **Crash containment**: a node-pty native crash should take down only the host (or
  one agent), not the API server — and the host should be independently respawnable.

## Acceptance

- Kill the API server mid-run → agents keep running → server restarts and shows them
  live again (no spurious `failed`).
- A native node-pty crash isolates to the host; API/UI stay up.
