// Section 19.4 — DAG topology. Pure, I/O-free. Lifted pattern from Archon's
// buildTopologicalLayers (Kahn's algorithm), re-expressed over PC's FORWARD
// `next` edges instead of Archon's backward `depends_on`.
//
// Reject back-edges (review node → back_to) are NOT forward edges: they are
// excluded from layering and cycle detection so a kick-back never reads as a
// cycle. The executor handles them separately via iteration counts.

import type { WorkflowV2 } from '@pc/domain';

type Node = WorkflowV2.WorkflowNode;

/** Forward successors of a node — its `next` edges. (Review nodes' `next` is
 *  the on-approve path; `reject.back_to` is a back-edge and excluded here.) */
export function forwardEdges(node: Node): readonly string[] {
  return node.next ?? [];
}

/** node id → ids of nodes that list it in their `next`. Used for trigger_rule
 *  join semantics and the default `bundle_from` (a review node's immediate
 *  upstreams). */
export function computeUpstreams(nodes: readonly Node[]): Map<string, string[]> {
  const up = new Map<string, string[]>();
  for (const n of nodes) up.set(n.id, []);
  for (const n of nodes) {
    for (const succ of forwardEdges(n)) {
      up.get(succ)?.push(n.id);
    }
  }
  return up;
}

/**
 * Kahn's algorithm over forward edges. Layer 0 = nodes with no incoming
 * forward edge; layer N = nodes whose forward-predecessors are all in layers
 * 0..N-1. Independent nodes within a layer are safe to run concurrently.
 *
 * Throws on a cycle (sum of layer sizes < node count). Cycle detection is the
 * load-time validator's job (19.6); this throw is a runtime safety net.
 * Edges to unknown node ids are ignored (the validator rejects those at save).
 */
export function buildTopologicalLayers(nodes: readonly Node[]): Node[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const n of nodes) {
    for (const succ of forwardEdges(n)) {
      if (indeg.has(succ)) indeg.set(succ, (indeg.get(succ) ?? 0) + 1);
    }
  }

  const layers: Node[][] = [];
  let ready = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0);

  while (ready.length > 0) {
    layers.push(ready);
    const next: Node[] = [];
    for (const n of ready) {
      for (const succ of forwardEdges(n)) {
        if (!indeg.has(succ)) continue;
        const d = (indeg.get(succ) ?? 0) - 1;
        indeg.set(succ, d);
        if (d === 0) {
          const sn = byId.get(succ);
          if (sn) next.push(sn);
        }
      }
    }
    ready = next;
  }

  const placed = layers.reduce((sum, l) => sum + l.length, 0);
  if (placed < nodes.length) {
    throw new Error('[dag] cycle detected at runtime — cycle check should run at load (19.6)');
  }
  return layers;
}

/**
 * Find a cycle in the forward graph (for the 19.6 save-time validator). Returns
 * the node ids on the cycle (in visitation order) or `null` when acyclic.
 * Reject back-edges are excluded (they're allowed to point "backward").
 */
export function findForwardCycle(nodes: readonly Node[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    color.set(id, GRAY);
    stack.push(id);
    const node = byId.get(id);
    for (const succ of node ? forwardEdges(node) : []) {
      if (!byId.has(succ)) continue; // unknown target — validator handles it
      const c = color.get(succ);
      if (c === GRAY) {
        // back to a node on the current stack → cycle
        const from = stack.indexOf(succ);
        return [...stack.slice(from), succ];
      }
      if (c === WHITE) {
        const found = dfs(succ);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const found = dfs(n.id);
      if (found) return found;
    }
  }
  return null;
}
