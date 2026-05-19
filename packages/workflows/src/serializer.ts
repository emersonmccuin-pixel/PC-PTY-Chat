// Round-trippable YAML emitter for typed `Workflow` objects. Used by the
// conversational workflow-creator path (4b.1) — model emits a typed object
// via `pc_create_workflow`, server validates, then this serializer writes
// the final YAML file to disk.
//
// Output is parser-equivalent: `parseWorkflowText(serializeWorkflow(wf))`
// returns the same logical `Workflow` (modulo the post-parse `kind:`
// discriminator the validator adds — the on-disk YAML never carries it).
//
// Key-order is fixed (id → description → triggers → disabled →
// attached_to_work_item → inputs → outputs → worktree → scratch_cleanup →
// nodes) so the on-disk shape stays human-readable and diff-friendly across
// emits. Within nodes the type-body field (subagent/bash/http/…) gets
// emitted with the base fields preserved in their typed-object order.

import { dump as yamlDump } from 'js-yaml';

import type { DagNode, LoopNode, Workflow } from '@pc/domain';

export function serializeWorkflow(workflow: Workflow): string {
  const out: Record<string, unknown> = { id: workflow.id };
  if (workflow.description !== undefined) out.description = workflow.description;
  if (workflow.triggers !== undefined) out.triggers = workflow.triggers;
  if (workflow.disabled === true) out.disabled = true;
  if (workflow.attached_to_work_item !== undefined) {
    out.attached_to_work_item = workflow.attached_to_work_item;
  }
  if (workflow.inputs !== undefined) out.inputs = workflow.inputs;
  if (workflow.outputs !== undefined) out.outputs = workflow.outputs;
  if (workflow.worktree !== undefined) out.worktree = workflow.worktree;
  if (workflow.scratch_cleanup !== undefined) out.scratch_cleanup = workflow.scratch_cleanup;
  out.nodes = workflow.nodes.map(stripKind);
  return yamlDump(out, { lineWidth: 0, noRefs: true });
}

// `kind:` is the validator's post-parse TS discriminator — never present in
// the on-disk YAML. Strip from each node; recurse into `loop.body` since
// nested nodes carry their own `kind:`.
function stripKind(node: DagNode): Record<string, unknown> {
  const { kind: _k, ...rest } = node as DagNode & { kind?: string };
  if (node.kind === 'loop') {
    const loop = (node as LoopNode).loop;
    return {
      ...rest,
      loop: {
        body: loop.body.map(stripKind),
        until: loop.until,
        max_iterations: loop.max_iterations,
      },
    };
  }
  return rest;
}
