// Body templating for agent system prompts (Section 3 / D7).
//
// At workflow dispatch time the runtime renders `{{var}}` placeholders in the
// agent body against a context supplied by the calling node. The agent itself
// never sees raw `{{...}}` — by the time the body reaches claude.exe every
// placeholder is either substituted or the dispatch has aborted with a clear
// error.
//
// Recognized variables (per the D7 contract in `docs/buildout/subagents.md`):
//   {{input}}             — text/data the workflow node fed in
//   {{worktree}}          — absolute path to the assigned worktree
//   {{workflow.id}}       — workflow run identifier (for pc_complete_node)
//   {{node.id}}           — node identifier within the workflow
//   {{project.name}}      — project display name
//   {{project.path}}      — project folder absolute path
//   {{wi.id}}             — work item id (if any)
//   {{wi.title}}          — work item title (if any)
//   {{wi.body}}           — work item body markdown (if any)
//
// Two failure modes — both throw `AgentBodyTemplateError`:
//   1. Unknown variable name (not in the recognized set above).
//   2. Recognized variable whose value isn't in the supplied context (e.g.
//      `{{wi.title}}` when no work item was provided).
//
// Render collects every unresolved placeholder before throwing so the caller
// sees the whole list, not just the first one.

export interface AgentBodyContextWorkItem {
  id: string;
  title: string;
  body: string;
}

export interface AgentBodyContext {
  input?: string;
  worktree?: string;
  workflow?: { id: string };
  node?: { id: string };
  project?: { name: string; path: string };
  wi?: AgentBodyContextWorkItem;
}

/** Full set of variable names the renderer recognizes. Anything outside this
 *  list is rejected as "unknown variable." */
export const AGENT_BODY_VARIABLES: readonly string[] = [
  'input',
  'worktree',
  'workflow.id',
  'node.id',
  'project.name',
  'project.path',
  'wi.id',
  'wi.title',
  'wi.body',
];

export interface AgentBodyTemplateIssue {
  /** The variable name as it appeared inside the braces, normalized
   *  (whitespace trimmed). E.g. `wi.title`. */
  variable: string;
  /** Why this placeholder couldn't be resolved. */
  reason: 'unknown' | 'missing';
  /** Character offset of the opening `{{` in the source body. */
  position: number;
  /** Human-readable explanation. */
  message: string;
}

export class AgentBodyTemplateError extends Error {
  readonly issues: AgentBodyTemplateIssue[];

  constructor(issues: AgentBodyTemplateIssue[]) {
    const lines = issues.map((i) => `  • ${i.message}`).join('\n');
    super(`Agent body has unresolved placeholders:\n${lines}`);
    this.name = 'AgentBodyTemplateError';
    this.issues = issues;
  }
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Resolve a recognized variable name against the context. Returns `undefined`
 *  when the variable is recognized but the context didn't supply it. */
function resolve(variable: string, ctx: AgentBodyContext): string | undefined {
  switch (variable) {
    case 'input':
      return ctx.input;
    case 'worktree':
      return ctx.worktree;
    case 'workflow.id':
      return ctx.workflow?.id;
    case 'node.id':
      return ctx.node?.id;
    case 'project.name':
      return ctx.project?.name;
    case 'project.path':
      return ctx.project?.path;
    case 'wi.id':
      return ctx.wi?.id;
    case 'wi.title':
      return ctx.wi?.title;
    case 'wi.body':
      return ctx.wi?.body;
    default:
      return undefined;
  }
}

/** Render an agent body by substituting `{{var}}` placeholders against `ctx`.
 *
 *  - Whitespace inside the braces is tolerated (`{{ input }}` ≡ `{{input}}`).
 *  - A body with no placeholders is returned verbatim.
 *  - On any unresolved placeholder (unknown name OR known name w/ missing
 *    value) throws `AgentBodyTemplateError` listing every issue. */
export function renderAgentBody(body: string, ctx: AgentBodyContext): string {
  const issues: AgentBodyTemplateIssue[] = [];

  const rendered = body.replace(PLACEHOLDER, (match, rawName: string, offset: number) => {
    const variable = rawName.trim();

    if (!AGENT_BODY_VARIABLES.includes(variable)) {
      issues.push({
        variable,
        reason: 'unknown',
        position: offset,
        message: `unknown variable {{${variable}}} (recognized: ${AGENT_BODY_VARIABLES.join(', ')})`,
      });
      return match;
    }

    const value = resolve(variable, ctx);
    if (value === undefined) {
      issues.push({
        variable,
        reason: 'missing',
        position: offset,
        message: `{{${variable}}} was not supplied by the workflow context`,
      });
      return match;
    }

    return value;
  });

  if (issues.length > 0) throw new AgentBodyTemplateError(issues);
  return rendered;
}

/** Concrete sample context the form-editor preview pane uses so authors can
 *  see what every placeholder renders to without dispatching a real run. */
export const EXAMPLE_AGENT_BODY_CONTEXT: Required<AgentBodyContext> = {
  input: '<sample input from the workflow node>',
  worktree: 'C:/projects/example/.worktrees/wi-01HZX',
  workflow: { id: 'wr_01HZXABCDEFG' },
  node: { id: 'do-the-thing' },
  project: { name: 'Example Project', path: 'C:/projects/example' },
  wi: {
    id: 'wi_01HZX',
    title: 'Draft the Q3 launch announcement',
    body: 'Audience: existing customers.\nTone: confident, not breathless.\nLength: <200 words.',
  },
};
