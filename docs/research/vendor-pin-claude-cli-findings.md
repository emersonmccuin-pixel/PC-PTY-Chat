# Research: vendoring + pinning + config-dir isolation for the Claude Code CLI

Source card: pc-pty-chat-97 (Vendor + pin the Claude Code CLI). Researcher findings,
2026-05-29. Facts only — no implementation plan. Cited file:line for our code; URLs for
external facts. Unknowns are flagged explicitly.

External sources:
- Setup / install / updates: https://code.claude.com/docs/en/setup
- Environment variables: https://code.claude.com/docs/en/env-vars
- Authentication / credentials: https://code.claude.com/docs/en/authentication

---

## 1. VENDORING MECHANISM

**npm-global is officially supported and ships the SAME native binary.**
- `npm install -g @anthropic-ai/claude-code` (requires Node 18+). Per the setup doc: the npm
  package installs the same native binary as the standalone installer; npm pulls it in via a
  per-platform optional dependency (e.g. `@anthropic-ai/claude-code-darwin-arm64`) and a
  postinstall step links it. The installed `claude` binary does NOT itself invoke Node.
  Runtime behaviour (JSONL, hooks, MCP, resume) is a property of that one binary, so it is
  identical across install methods; only delivery + update differs. Node is link-time only.
- Supported npm platforms: darwin-arm64/x64, linux-x64/arm64 (+ musl), win32-x64/arm64.
- Pinning: `npm install -g @anthropic-ai/claude-code@X.Y.Z` pins exactly. Doc warns
  `npm update -g` respects the original semver range and may not move to newest (helpful: no
  silent jump). The native installer also pins: `curl .../install.sh | bash -s 2.1.89`.
- No documented per-method behavioural differences beyond auto-update + install location.
  UNKNOWN: Anthropic does not guarantee JSONL/hook/MCP byte-identity across methods in writing;
  our jsonl-tailer + ready-gate contract checks remain the empirical gate (the "bless a new
  CLI" pipeline in pc-pty-chat-97).
- `claude --version` prints e.g. `2.1.150 (Claude Code)` (dev binary 2.1.150, preflight.ts:24).
  Preflight already parses the numeric prefix via regex (preflight.ts:71-74). Assert on the
  parsed numeric token, not the whole decorated line.
- Integrity: GPG-signed `manifest.json` of SHA256 checksums (signatures from 2.1.89 on), key
  fingerprint 31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE; macOS notarized, Windows
  Authenticode-signed. Hook for verifying a vendored binary at build time.

## 2. AUTO-UPDATE DEFEAT (the linchpin)

**There IS a documented hard guarantee: `DISABLE_UPDATES`.**
- By method: native install auto-updates in background (checks on startup + periodically,
  applies next start) — the method that fights us. npm-global also auto-updates, BUT if the
  npm global dir is not writable it cannot, and shows a one-time startup notice — a
  filesystem-level brake. Homebrew/WinGet/apt/dnf/apk do NOT auto-update by default.
- Disable levers (in the `env` key of settings.json):
  - `DISABLE_AUTOUPDATER=1`: only stops the background check; `claude update`/`claude install`
    still work. NOT sufficient alone.
  - `DISABLE_UPDATES`: blocks ALL update paths including manual — doc says use this "when you
    distribute Claude Code through your own channels and need users to stay on the version you
    provide." This is the purpose-built guarantee for our exact use case.
  - `minimumVersion` setting: a version FLOOR (auto-update + `claude update` refuse anything
    below it). Floor, not freeze.
  - `autoUpdatesChannel` (`latest` default / `stable` ~1 week behind), enforceable org-wide via
    managed settings.
- Defense-in-depth (facts, not a plan): DISABLE_UPDATES in PC's session settings.json + a
  read-only vendored binary dir + preflight version assertion (section 5).
- Plugs into our code: PC already injects a session-local `--settings` file with
  `--setting-sources ''` (claude-runtime-bundle.ts:60-72, pty-session.ts:236-241,
  low-level-spawn.ts:560-565). The `env` block of templates/.claude/settings.template.json is
  the natural home for DISABLE_UPDATES. TO-VERIFY: that DISABLE_UPDATES is honoured via the
  `--settings` env block, not only the user-global settings.json.

## 3. CONFIG-DIR ISOLATION (end-to-end, OUR code)

**What CLAUDE_CONFIG_DIR relocates (docs):** "a completely isolated Claude Code installation
with separate credentials, settings, history, plugins, agents, and hooks." Auth doc confirms
`.credentials.json` moves under it on Linux/Windows. Session transcripts
(`projects/<encoded-cwd>/<uuid>.jsonl`) live under it too. So ONE env var relocates auth +
settings + history + session JSONL + plugins/agents/hooks. macOS caveat: credentials stay in
the encrypted Keychain even with CLAUDE_CONFIG_DIR set (only Linux/Windows route creds to the
dir).

**Section 33 already built most of this.** `claudeConfigDir: string | null` override exists:
- field: settings.ts:78 (null = inherit shell).
- pure resolver `resolveClaudeConfigDirEnv(override, shellValue)`: settings.ts:129-134.
- applied to process.env at boot + every PATCH: settings-onboarding/routes.ts:52-63, called
  from index.ts:106; shell value captured at import (routes.ts:34) so clearing restores it.
- single source of truth for paths: path-resolver.ts — claudeConfigDir() 15-17,
  claudeProjectsRoot() 19-21, projectDirFor() 27, jsonlPathFor() 31-36, inverse
  claudeConfigDirFromJsonlPath() 48-54. All honour CLAUDE_CONFIG_DIR.

**Every read + what it computes + breakage if repointed to a private dir:**
- path-resolver.ts:15-36 — config dir / projects root / jsonl path. HONORS env. The seam.
- pty-session.ts:342 — JSONL discovery root via claudeProjectsRoot(). HONORS env. The
  documented homedir scar (pty-session.ts:335-341 comment) is FIXED here.
- low-level-spawn.ts:215-217 — resolved JSONL path via jsonlPathFor(). HONORS env.
- project-runtime.ts:443,492 — derives jsonlPath; injects CLAUDE_CONFIG_DIR into the per-spawn
  env IF session.claudeConfigDir set. HONORS env (per-session).
- agent-run-boot-reconcile.ts:176, agent-host-reattach.ts:282 — jsonlPathFor() for reattach.
  HONORS env.
- SCAR jsonl-sweep.ts:53-54 defaultClaudeProjectsDir() — HARDCODES join(homedir(),'.claude',
  'projects'). Under a private dir the retention sweep scans the WRONG root: never deletes
  private-dir JSONL (disk leak) and could scan/delete the employee's personal ~/.claude. Should
  call claudeProjectsRoot().
- SCAR custom-commands.ts:21 — resolve(homedir(),'.claude','commands'), hardcoded. Reads
  personal-dir slash-commands, not the private dir.
- SCAR memory-files.ts:26 — resolve(homedir(),'.claude','CLAUDE.md'), hardcoded. Global memory
  read from personal dir.
- migrate.ts:30, settings routes:48,131 (homedir for default projectsFolder), fs-probe.ts:83-85,
  data-dir.ts:34-35, fs-browse.ts:50 (~ expansion) — NOT CC paths; benign.

**Net:** spawn + chat-replay + reattach already honour CLAUDE_CONFIG_DIR (Section 33 + 23). The
pty-session homedir scar from project memory is FIXED. Three residual homedir hardcodes are the
remaining work: jsonl-sweep.ts:54, custom-commands.ts:21, memory-files.ts:26.

**Nuance for the planner:** project-runtime.ts:492 sets CLAUDE_CONFIG_DIR on the per-spawn env
from session.claudeConfigDir, while index.ts:106 sets it on server process.env. If the two
disagree, a spawn writes JSONL under dir A while the host derives paths under dir B — the exact
silent-empty-chat class the pty-session.ts:335-341 comment warns about. Distribution mode wants
ONE authoritative private dir set process-wide before any spawn.

## 4. PER-EMPLOYEE AUTH inside a private config dir

**Auth modes (auth doc), precedence order:** (1) cloud provider via CLAUDE_CODE_USE_BEDROCK/
VERTEX/FOUNDRY; (2) ANTHROPIC_AUTH_TOKEN (Bearer; gateways); (3) ANTHROPIC_API_KEY (X-Api-Key;
Console key; interactive approves once, `-p` always uses); (4) apiKeyHelper script (rotating;
TTL via CLAUDE_CODE_API_KEY_HELPER_TTL_MS); (5) CLAUDE_CODE_OAUTH_TOKEN (1-year token from
`claude setup-token`); (6) subscription OAuth from `/login` (default Pro/Max/Team/Enterprise).

**Credential location vs CLAUDE_CONFIG_DIR:** macOS = encrypted Keychain (does NOT move with the
env var); Linux = ~/.claude/.credentials.json (0600); Windows = %USERPROFILE%\.claude\
.credentials.json. On Linux/Windows, if CLAUDE_CONFIG_DIR is set the `.credentials.json` lives
under that dir → clean per-employee isolation. macOS is the exception (Keychain-shared).

**Non-interactive seeding:** `claude setup-token` runs OAuth, prints a 1-year token, saves
nothing → copy into CLAUDE_CODE_OAUTH_TOKEN (CI/headless; inference-only, cannot do Remote
Control, ignored by `--bare`). ANTHROPIC_API_KEY works non-interactively under `-p`. Doc note:
from 2026-06-15 Agent SDK + `claude -p` on subscription plans draw from a separate monthly Agent
SDK credit. Our onboarding already drives interactive `claude auth login --claudeai` (browser
OAuth) polling `claude auth status` — onboarding-auth.ts; writes .credentials.json (private dir
if env set at spawn); preflight.ts:141-164 reads `auth status --json` {loggedIn}. UNKNOWN:
whether `auth login`/`setup-token` honour CLAUDE_CONFIG_DIR on macOS (Keychain) — verify in dev.

## 5. DRIFT DETECTION

- `claude --version` is viable and already wired: preflight runVersion()+parseVersion(), gated
  vs MIN_CLAUDE_VERSION='2.0.0' (preflight.ts:25), typed status ok|not-found|version-too-old|
  unverified (preflight.ts:29-37,105-135).
- Where to assert expected-vs-actual: checkClaude() (preflight.ts:105) does a FLOOR check. For
  pinning, add an exact EXPECTED_CLAUDE_VERSION comparison + a new status (e.g. version-drift)
  so the UI says "expected X, found Y" instead of leaking corrupted-JSONL symptoms downstream.
  Version is already in the report; wiring is a compare + enum value.
- `claude doctor` also reports the most recent update attempt — secondary signal.

---

## Summary

- **Vendoring (Q1):** npm-global `@anthropic-ai/claude-code@X.Y.Z` is fully supported and
  installs the SAME native binary as the installer (Node link-time only; `claude` doesn't
  invoke Node). JSONL/hooks/MCP/resume behaviour is a property of that one binary → identical
  across methods, but our contract checks remain the empirical gate. `claude --version` →
  `2.x.y (Claude Code)`; assert the parsed numeric prefix. GPG-signed manifests + code-signing
  give build-time integrity.
- **Auto-update defeat (Q2):** documented hard guarantee = `DISABLE_UPDATES` (blocks ALL update
  paths incl. manual; explicitly for self-distribution). `DISABLE_AUTOUPDATER` alone only stops
  the background check. `minimumVersion` floor + a non-writable install dir are defense-in-depth.
- **Config-dir isolation (Q3):** CLAUDE_CONFIG_DIR relocates auth + settings + history + session
  JSONL + plugins/agents/hooks (macOS keeps creds in Keychain — exception). Section 33 already
  threads it end-to-end; the pty-session homedir scar is FIXED. Three residual hardcodes are the
  real work: jsonl-sweep.ts:54 (retention — disk leak + can hit personal dir),
  custom-commands.ts:21, memory-files.ts:26. Also reconcile process-wide (index.ts:106) vs
  per-session (project-runtime.ts:492) CLAUDE_CONFIG_DIR.
- **Per-employee auth (Q4):** modes = subscription OAuth, ANTHROPIC_API_KEY, long-lived
  CLAUDE_CODE_OAUTH_TOKEN via `claude setup-token`, apiKeyHelper, cloud providers. On
  Linux/Windows `.credentials.json` lives under CLAUDE_CONFIG_DIR → per-employee isolation;
  macOS Keychain is the exception. Non-interactive seeding exists (setup-token / API key); our
  onboarding drives interactive `claude auth login`. Flags: macOS Keychain, 2026-06-15 SDK
  credit change.
- **Drift detection (Q5):** `claude --version` viable + already wired in preflight.ts; extend
  checkClaude() with an exact EXPECTED_CLAUDE_VERSION compare + a `version-drift` status to fail
  loud.

### Flagged unknowns (verify in dev)
1. JSONL/hook/MCP byte-identity across install methods is undocumented as a guarantee — keep the
   contract checks.
2. Whether DISABLE_UPDATES is honoured via the `--settings` env block vs only user-global
   settings.json.
3. macOS credential behaviour under CLAUDE_CONFIG_DIR (Keychain, not the dir) for runtime AND
   `claude auth login` / `setup-token`.
4. Process-wide vs per-session CLAUDE_CONFIG_DIR agreement in distribution mode.
