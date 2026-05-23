// Human-friendly labels for tool names. The canonical name (what claude.exe
// gates against, what we store in DB / materialised .md frontmatter) stays
// raw — this helper only formats the label for display.
//
// Three cases:
//   1. pc-rig tools (`mcp__pc-rig__pc_<verb>_<noun>`) → strip prefix,
//      humanize the snake_case rest. e.g. `mcp__pc-rig__pc_list_agents`
//      → "List agents".
//   2. Other MCP tools (`mcp__<server>__<tool>`) → "<server>: <humanized tool>".
//      e.g. `mcp__snowflake__query` → "snowflake: Query".
//   3. Built-in CC tools (PascalCase) → split camelCase + sentence-case.
//      e.g. `WebFetch` → "Web fetch", `Read` → "Read".

const PC_RIG_PREFIX = 'mcp__pc-rig__pc_';
const MCP_PREFIX = 'mcp__';

function humanizeSnake(s: string): string {
  if (!s) return s;
  const spaced = s.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function humanizeCamel(s: string): string {
  if (!s) return s;
  const spaced = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function formatToolLabel(name: string): string {
  if (name.startsWith(PC_RIG_PREFIX)) {
    return humanizeSnake(name.slice(PC_RIG_PREFIX.length));
  }
  if (name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length);
    const sepIdx = rest.indexOf('__');
    if (sepIdx > 0) {
      const server = rest.slice(0, sepIdx);
      const tool = rest.slice(sepIdx + 2);
      if (tool === '*') return `${server}: all tools`;
      return `${server}: ${humanizeSnake(tool)}`;
    }
    return name;
  }
  return humanizeCamel(name);
}
