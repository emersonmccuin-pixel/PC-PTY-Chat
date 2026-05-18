// Mirror of `packages/domain/src/agent-body.ts` — kept inline here so the web
// bundle doesn't pull in @pc/domain (same rationale as `apps/web/src/api/client.ts`).
// Used by the AgentEditor preview pane; the workflow runtime renders against
// the authoritative implementation in @pc/domain.
//
// Keep the variable set + behavior in lock-step with the domain copy. The
// domain test suite at `packages/domain/test/agent-body.test.ts` pins the
// contract.

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
  variable: string;
  reason: 'unknown' | 'missing';
  position: number;
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
