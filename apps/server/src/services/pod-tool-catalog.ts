// Section 17a.5 — Static catalog of pc-rig tool names.
//
// The pod materialiser expands `mcp__pc-rig__*` wildcards in pod `tools:`
// allowlists into explicit names — CC's `tools:` frontmatter is exact-name
// match only, no wildcard support.
//
// Section 36 — derived from `TOOLS` in `packages/mcp/src/server.ts`.
// Previously two hand-maintained lists drifted on every new MCP tool (the
// `pc-rig-catalog-drift` invisibility bug); a `pod-tool-catalog-drift.test.ts`
// asserted parity. Both are gone. `TOOLS` is the sole source; this module
// re-exports the fully-qualified slugs for the wildcard expander.

export { PC_RIG_TOOL_NAMES } from '@pc/mcp';
