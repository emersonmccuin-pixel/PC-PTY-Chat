# Design — Out-of-process agent host (durable crash isolation)

Status: draft for review. Logged 2026-05-28. Supersedes the sketch in
`out-of-process-agents-todo.md` (keep that as the problem statement).

## Goal

Agent PTYs survive an API-server crash/restart; the server reattaches on boot.
A native node-pty crash isolates to the host — API/UI stay up.

Acceptance (from the TODO):
- Kill the API server mid-run → agents keep running → server restarts and shows
  them live again (no spurious `failed`).
- A native node-pty crash isolates to the host; API/UI stay up.

## Today's coupling (why a restart kills agents)

- Every `claude.exe` is `pty.spawn`'d **inside the server process** via
  `LowLevelSpawn` (`packages/runtime/src/low-level-spawn.ts`). ConPTY tears the
  children down when their parent (the server) dies.
- Live run state is **in-memory only**:
  - `AgentRun` instances — state machine + idle/wall-clock/spawn-stuck timers
    (`packages/runtime/src/agent-run.ts`).
  - `ActiveRunRegistry` — `byRunId` / `byCcSession` maps
    (`apps/server/src/services/agent-active-runs.ts`).
  - `AgentRunRegistry` — cap + FIFO queue (`packages/runtime/src/agent-run-registry.ts`).
- On boot `reconcileOrphanedRunningRuns` blanket-flips every
  `queued|spawning|running|paused` row to `failed/server-restart`
  (`packages/db/src/repos/agent-runs.ts:197`).
- Packaged app runs the server **in-process inside Electron main**
  (`apps/desktop/src/main.ts:55`), so a native node-pty crash currently kills the
  whole app, not just a worker.

## The seam we exploit

`AgentRun` already depends on PTYs only through the `SpawnLike` interface,
injected via `spawnFactory` (`agent-run.ts:74-87, 125-131`). If we provide a
`SpawnLike` implementation that proxies an out-of-process PTY, **the state
machine, timeouts, terminal logic, and all the existing wiring in
`agent-run-factory.ts` stay essentially unchanged.** This is the spine of the
design.

Second seam: `jsonl-event` (the conversation content) is independent of PTY
ownership. JSONL is canonical on disk (memory `reference_chat_jsonl_canonical_source`).
So we split responsibilities along the natural line:

- **Host owns the PTY control plane** — `pty.spawn`, raw stdout, trust/channel
  auto-confirm, `ReadyGate`, the bracketed-paste/echo-ack `send` (needs the raw
  buffer), resize/interrupt/kill, transcript write.
- **Server owns content + lifecycle** — tails JSONL from disk (`JsonlTailer`),
  runs the `AgentRun` state machine, persists rows, drives the UI.

Because content is re-derived from disk, **reattach needs no IPC replay**: the
server just re-opens the tailer at the persisted cursor.

## Process topology

```
                  ┌─────────────────────────────┐
   outermost      │  Agent Host  (long-lived)   │  owns node-pty + claude.exe
   supervisor ───▶│  - LowLevelSpawn (PTY only) │  children; survives server
   (dev-super /   │  - ReadyGate, send-protocol │  restart; own respawn
    electron main)│  - control WS server :PORT  │
                  └──────────────┬──────────────┘
                                 │ localhost WS (control channel)
                  ┌──────────────┴──────────────┐
                  │  API Server  (volatile)     │  reconnects on every boot
                  │  - AgentRun state machine   │
                  │  - RemoteSpawn (SpawnLike)  │  ← dropped into spawnFactory
                  │  - JsonlTailer (disk)       │
                  │  - Active/Run registries    │
                  └─────────────────────────────┘
                                 │ tails
                          <dataDir>/.../*.jsonl  (canonical content)
```

- **Host is the stable anchor; server is the volatile client.** The host is
  started once by the outermost owner and is *not* restarted when the server
  restarts.
- **Dev:** `dev-supervisor.mjs` spawns the host as a sibling and keeps it alive
  across server sentinel-75 restarts; tears it down only on its own SIGINT/SIGTERM.
- **Packaged:** Electron `main.ts` **forks the host as a child process** (today it
  imports the server in-process). The host child must be separate so a native
  crash can't kill Electron main. App `before-quit` kills the host.

## Transport

Localhost **WebSocket** control channel on a dedicated port (dev `:88xx`,
dogfood `:87xx` — pick free ports adjacent to the existing channel ports). WS,
not `child_process.fork` IPC, because in dev the server is not a child of the
host (both are siblings under the supervisor); WS is uniform across dev/packaged
and the codebase already has WS reconnect plumbing (the channel server).

The control channel carries **commands + lifecycle events only** — never JSONL
content (that stays on disk).

### Messages

Server → Host:
| msg | payload | reply |
|---|---|---|
| `spawn` | `{ key, spawnInput, transcriptPath }` | `spawned{ key, pid }` (async) |
| `attach` | `{ key }` | `attached{ key, pid, state } \| gone{ key }` |
| `send` | `{ key, body, echoTimeoutMs, reqId }` | `send-result{ reqId, result }` |
| `writeRaw` | `{ key, bytes }` | — |
| `interrupt` | `{ key }` | — |
| `resize` | `{ key, cols, rows }` | — |
| `kill` | `{ key, graceMs }` | — |
| `notify-handshake` | `{ key }` | — |
| `roster` | `{ reqId }` | `roster{ reqId, sessions:[{ key, pid, state }] }` |

Host → Server:
| msg | payload |
|---|---|
| `state` | `{ key, state }` |
| `ready` | `{ key, ts }` |
| `chunk` | `{ key, text }` — interactive/live-terminal only (see Scope) |
| `exit` | `{ key, code, signal }` |

`key` = `agentRunId` (durable; reused on reattach so the host re-binds the same
PTY). `ccSessionId` is also carried so the host can resolve the JSONL path.

## Server-side: `RemoteSpawn implements SpawnLike`

A `RemoteSpawn` wraps **(a)** an IPC control proxy and **(b)** a server-side
`JsonlTailer`, re-emitting the union as the exact events `AgentRun` already
expects:

- `start()` → send `spawn`; on `spawned` begin tailer once JSONL appears.
- `awaitReady()` → resolves on `ready` IPC event (or timeout, mirroring today).
- `send()` → `send` command, await `send-result`.
- `writeRaw/interrupt/resize/kill/notifyMcpHandshake` → fire IPC commands.
- `jsonl-event` → from the **local tailer** (disk), not the wire.
- `state/ready/exit/chunk` → from IPC.

Injected unchanged via `deps.spawnFactory` in `agent-run-factory.ts:557`.
`AgentRun` itself needs **no changes**.

The MCP-handshake HTTP route (`/api/internal/mcp-handshake`) keeps calling
`run.notifyMcpHandshake()` → `RemoteSpawn` forwards it as `notify-handshake`.

## Reattach + targeted reconcile (the core behavior change)

`reconcileOrphanedRunningRuns` stops being a blanket fail. New boot sequence:

1. Server connects to the host; sends `roster`.
2. For each DB row in `{queued,spawning,running,paused}`:
   - **Host has a live PTY** (`key` in roster) → **reattach**:
     - Construct an `AgentRun` in attach mode with a `RemoteSpawn` that sends
       `attach` (not `spawn`) and starts a tailer at the **persisted JSONL
       cursor**.
     - Re-register in `ActiveRunRegistry`; re-admit into `AgentRunRegistry` via a
       new `reattach()` that takes a slot **without** going through the FIFO
       (it's already running).
     - Re-arm timers from persisted timestamps (see Durability).
     - Keep status as-is.
   - **Host has no PTY** for it:
     - If JSONL shows a turn-end after the row's last cursor → mark `completed`
       (we missed the terminal during the gap).
     - Else → `failed/server-restart` (the *only* surviving blanket-ish case,
       now narrowed to genuinely-dead runs).
3. `queued` rows the host never spawned (server died before spawn) → re-dispatch
   or fail per policy (recommend: fail with a distinct cause so the orchestrator
   can retry cleanly).

## Run-state durability on reattach

| State | Today | Reattach plan |
|---|---|---|
| wall-clock timer | in-memory | re-arm `wallClockMs - (now - spawnedAt)` from DB |
| idle timer | in-memory | re-arm fresh (idle is a safety net; resetting on a rare restart is acceptable) |
| spawn-stuck timer | in-memory | only relevant in `spawning`; re-arm fresh, or fail if host says PTY already gone |
| cap slot | in-memory | rebuild by `reattach()`-admitting each live run at boot |
| pause + pendingAskId | `paused` status + pending-asks repo (persisted) | rehydrate from DB + `pending-asks` repo |

No new schema strictly required if we accept fresh idle timers; optionally
persist `lastActivityAt` for exact idle restoration (defer).

## Host crash containment + respawn

- The host can still hit the native crash. When it does its agents die — that is
  the **irreducible** blast radius — but the API/UI (separate process) survive.
  This is already strictly better than today (same crash kills everything).
- The host has its **own respawn** (small supervisor loop, mirrors
  `dev-supervisor`'s healthy-then-crash auto-recover + cap).
- After a host respawn the host has no PTYs → the server's next `roster` sync
  finds them gone → targeted-fail/complete per the reconcile rules above.
- **Future blast-radius reduction (not in v1):** one host per N agents, or a
  host subprocess per agent. Start with a single shared host.

## Lifecycle / ownership (resolved 2026-05-28)

Restart semantics differ by mode (confirmed in code):

- **Dev:** server is a `tsx` child under `dev-supervisor.mjs`.
  `POST /api/dev/restart` → `exit(75)` → supervisor respawns. Soft restarts are
  frequent. (`dev-controls/routes.ts`, `constants.ts`.)
- **Packaged:** dev-controls are **disabled** (`isDevControlsEnabled()` is false
  when `PC_ROOT` is set — `constants.ts:11`), so there is **no soft restart**.
  The server runs **in-process inside Electron main** with no supervisor
  (`apps/desktop/src/main.ts:55`). The only "restart" is a full app quit +
  relaunch (e.g. `/promote-to-dogfood`). On Windows, Electron's job object kills
  child processes when the parent dies — so a plain child host would die on the
  exact event we need it to survive (an Electron-main native crash / relaunch).

**Unified model — the host is a standalone, detached process** addressed by a
well-known port + lock/pidfile, identical in both modes:

- **Spawn-if-not-running on connect.** Whoever boots first starts the host; later
  boots just connect. (Dev: the supervisor. Packaged: Electron main, spawning the
  host **detached** and excluded from the kill-on-parent-death job.)
- **Same host binary, same connect/reattach protocol, same reap logic** in dev
  and packaged — only the launcher differs. (Matches the "one system to maintain"
  goal.)
- **Idle-reap:** host exits when it has no live PTYs *and* no connected client for
  N minutes — so it doesn't linger forever after the app quits.
- **Explicit shutdown affordance** for "kill everything" (app uninstall, hard
  stop): a `shutdown` control message + a CLI/quit hook.

Net effect: a native crash kills only the host (API/UI/app survive); a server
restart *or* a full app relaunch reattaches to still-running agents; and an idle
host eventually cleans itself up.

## Scope decisions (settled 2026-05-28)

1. **All PTYs move to the host** — agents *and* interactive
   (`interactive-session.ts`, `pty-session.ts`). One spawn path, one supervisor,
   one reattach protocol to maintain; full crash isolation. Interactive sessions
   move to the host for isolation in phase 4; their reattach (reconnecting xterm
   after a server restart) is a later sub-phase.
2. **Single shared host in v1.** One host process holds every PTY. A native crash
   kills all live PTYs at once (irreducible for a shared process) but the API/UI
   survive — the headline win over today. Per-agent / host-per-N is a future
   blast-radius reduction, **not a one-way door**: the `key`-addressed protocol
   (`spawn{key}` / `attach{key}` / `roster`) is identical whether keys live in
   one host or many, so splitting later is a knob, not a redesign. Revisit only
   if the native crash recurs and the shared blast radius proves painful.

## Phasing

1. **Host process + control WS + `RemoteSpawn`**, agents only. ✅ **shipped
   (phase 1)** — see Implementation status below. Server still blanket-fails on
   boot (no reattach yet) — but a server crash no longer kills running agents
   mid-flight (they finish, write JSONL; next boot still fails the *row* but the
   work/transcript survived). Validates the split.
2. **Reattach + targeted reconcile.** Delivers the headline acceptance test.
3. **Host respawn + supervisor/Electron ownership wiring.** Delivers native-crash
   isolation.
4. **Interactive sessions onto the host** (isolation), then their reattach.

## Implementation status

**Phase 1 — shipped (off by default).**

- Runtime core (`packages/runtime/src/host/`): `protocol.ts`, `agent-host.ts`,
  `remote-spawn.ts`, `host-client.ts`; `LowLevelSpawn` gains `getPid()` +
  `suppressJsonlTailer`. 11 tests in `test/agent-host.test.ts`.
- Server wiring (`apps/server/src/agent-host/`): `ws-channel.ts`,
  `host-main.ts` (standalone host entry), `connect-host.ts` (connect +
  best-effort detached spawn-if-not-running), `constants.ts` (the
  `PC_AGENT_HOST` flag + port). `agent-run-factory` swaps the `spawnFactory` to
  `RemoteSpawn` when the host client is connected; `index.ts` boot does a
  fire-and-forget connect when the flag is set.

**How to try it (dev):** set `PC_AGENT_HOST=1` (optionally
`PC_AGENT_HOST_PORT`) for the server. On boot it connects to the host, spawning
one via tsx if none is listening (or run `pnpm --filter @pc/server agent-host`
manually). With the flag off, nothing changes — in-process spawns as today.

**Phase-1 limits (by design):** no reattach yet (boot still blanket-fails
rows); auto-spawn detachment isn't hardened against Windows job-object
teardown; interactive PTYs not yet routed through the host. Those are phases
2–4.

## What stays unchanged

`AgentRun`, `AgentRunRegistry` (plus a `reattach()` method), `JsonlTailer`,
`ReadyGate`, `send-protocol`, `ansi`, pod materialization, the MCP-handshake
route, and almost all of `agent-run-factory.ts`. The new code is the host
process, the WS protocol, `RemoteSpawn`, and the reconcile rewrite.

## Open questions

- Exact host ports (dev/dogfood) — adjacent to existing channel ports.
- `queued`-never-spawned policy: re-dispatch vs fail-with-retry-cause.
- Whether to persist `lastActivityAt` for exact idle-timer restoration (defer).
- Idle-reap window + the detached-spawn / job-object-exclusion mechanics on
  Windows (validate empirically in phase 3).
- Lock/pidfile vs port-probe for the spawn-if-not-running race (two boots racing
  to start the host).
```
