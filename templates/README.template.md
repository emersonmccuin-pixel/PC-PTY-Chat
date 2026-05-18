# {{PROJECT_NAME}}

Initialized by [Project Companion]({{PC_TRUNK_PATH}}).

## PC scaffold

- `.project-companion/workflows/` — DAG workflow YAMLs the PC runtime watches and dispatches.
- `.project-companion/orchestrator-prompt.md` — orchestrator PM identity, appended to `claude.exe`'s built-in system prompt at spawn via `--append-system-prompt-file`.
- `.claude/agents/` — per-project copies of agents from the global library (`~/.project-companion/agents/`). Edits diverge from the library.
- `.claude/hooks/` — per-project hook scripts (event capture, ask intercept, path guard, stop). Generated from PC templates.
- `.claude/settings.json` — per-project CC settings (hooks + permissions).
- `.mcp.json` — per-project MCP server config (project id injected via env).

Use PC's UI to manage work items, workflows, agents, and project settings.
