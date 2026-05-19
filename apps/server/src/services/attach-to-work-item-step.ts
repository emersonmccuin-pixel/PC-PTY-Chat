// attach-to-work-item step dispatcher (4a.5). Routes the workflow author's
// declared attachment through AttachmentService.create — same code path as the
// `pc_attach_to_work_item` MCP tool. Provenance fields (source='agent',
// agentName, workflowRunId, nodeId) are filled automatically from run context;
// the workflow author doesn't set them. agentName is derived by scanning the
// step's `depends_on` for the first subagent ancestor — null when none.
//
// Pure async function, takes the node + run + substituter + (resolved deps:
// AttachmentService, workflow for agentName lookup). Returns DispatchResult.

import type {
  AttachToWorkItemNode,
  DagNode,
  NodeOutput,
  SubagentNode,
  ULID,
  Workflow,
  WorkflowRun,
} from '@pc/domain';

import type { AttachmentService } from './attachment.ts';
import type { SubstituteTemplate } from './typed-substitution.ts';

export interface AttachToWorkItemStepResult {
  kind: 'sync';
  output: NodeOutput;
}

export interface AttachToWorkItemStepDeps {
  attachmentService: AttachmentService;
  workflow: Workflow;
  substituteTemplate: SubstituteTemplate;
}

export async function runAttachToWorkItemStep(
  node: AttachToWorkItemNode,
  run: WorkflowRun,
  deps: AttachToWorkItemStepDeps,
): Promise<AttachToWorkItemStepResult> {
  const completedAt = () => new Date().toISOString();
  const cfg = node['attach-to-work-item'];
  // workItemId + name are typed-port single-value fields (already resolved
  // by applyTypedPortEdges); template substituter is identity for those but
  // we pass through it for {{ }} placeholder support in mixed strings.
  const workItemId = deps.substituteTemplate(cfg.workItemId).trim();
  if (!workItemId) {
    return failedSync(
      `workItemId resolved to empty (raw: "${cfg.workItemId}")`,
      completedAt(),
    );
  }
  const name = deps.substituteTemplate(cfg.name).trim();
  if (!name) {
    return failedSync(`name resolved to empty (raw: "${cfg.name}")`, completedAt());
  }
  const content = deps.substituteTemplate(cfg.content);
  if (!content) {
    return failedSync(
      `content resolved to empty (raw: "${cfg.content}")`,
      completedAt(),
    );
  }
  const kind = cfg.kind ? deps.substituteTemplate(cfg.kind).trim() || 'text' : 'text';
  const contentType = cfg.contentType
    ? deps.substituteTemplate(cfg.contentType).trim() || null
    : null;

  const agentName = findUpstreamSubagentName(node, deps.workflow);

  try {
    const attachment = deps.attachmentService.create({
      workItemId: workItemId as ULID,
      kind,
      name,
      content,
      contentType,
      runId: run.id as ULID,
      source: 'agent',
      agentName,
      nodeId: node.id,
    });
    return {
      kind: 'sync',
      output: {
        status: 'complete',
        output: {
          id: attachment.id,
          workItemId: attachment.workItemId,
          name: attachment.name,
        },
        completedAt: completedAt(),
      },
    };
  } catch (err) {
    return failedSync(`attach failed: ${(err as Error).message}`, completedAt());
  }
}

/** Scan the step's depends_on for a subagent node; return its agent name when
 *  exactly one matches, else null. Used as the default `agentName` provenance
 *  for routing steps that consume a subagent's output. */
function findUpstreamSubagentName(
  node: AttachToWorkItemNode,
  workflow: Workflow,
): string | null {
  const deps = node.depends_on ?? [];
  const subagentDeps = deps
    .map((id) => workflow.nodes.find((n: DagNode) => n.id === id))
    .filter((n): n is SubagentNode => n !== undefined && n.kind === 'subagent');
  if (subagentDeps.length === 0) return null;
  return subagentDeps[0]!.subagent;
}

function failedSync(error: string, completedAt: string): AttachToWorkItemStepResult {
  return {
    kind: 'sync',
    output: { status: 'failed', error, completedAt },
  };
}
