// Section 19.8 — pure layout function for the v2 workflow visualizer.
//
// Takes a WorkflowV2.Workflow and returns positioned nodes + edges using
// elkjs's `layered` algorithm with orthogonal routing. Top-to-bottom direction
// matches the one-socket-per-side model (lock 6): top = in, bottom = out,
// side (EAST) = reject back-edge socket on review nodes.
//
// Async because elkjs's layout is Promise-returning. Pure: no DOM access, no
// React, no side effects. Safe to call from a useEffect.
//
// Authoring overlays (drag-to-move, manual positions) layer on top of the
// elkjs result in the React component — the layout here is the auto baseline.

import ELK, { type ElkNode, type ElkExtendedEdge, type ElkExtendedEdge as ElkEdge } from 'elkjs/lib/elk.bundled.js';
import { WorkflowV2 } from '@pc/domain';

const elk = new ELK();

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 88;

export type PortSide = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdgePoint {
  x: number;
  y: number;
}

export type EdgeKind = 'forward' | 'reject';

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Polyline bend points from elkjs (orthogonal routing). The first/last
   *  points are anchored at the source/target ports. */
  points: LayoutEdgePoint[];
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** Bounding box of the laid-out graph. Useful for sizing the canvas. */
  width: number;
  height: number;
}

/** Auto-layout the workflow. Returns positions in graph-local coordinates
 *  (top-left = 0,0). The React component owns the pan/zoom transform. */
export async function layoutWorkflow(wf: WorkflowV2.Workflow): Promise<LayoutResult> {
  const elkNodes: ElkNode[] = wf.nodes.map((n) => ({
    id: n.id,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    ports: portsForNode(n),
    layoutOptions: { 'portConstraints': 'FIXED_SIDE' },
  }));

  const elkEdges: ElkExtendedEdge[] = [];
  for (const n of wf.nodes) {
    for (const next of n.next ?? []) {
      elkEdges.push({
        id: `e:${n.id}->${next}`,
        sources: [`${n.id}__out`],
        targets: [`${next}__in`],
        labels: [{ id: `${n.id}-${next}-kind`, text: 'forward' }],
      });
    }
    if (WorkflowV2.isReviewNode(n) && n.reject) {
      elkEdges.push({
        id: `r:${n.id}->${n.reject.back_to}`,
        sources: [`${n.id}__reject`],
        targets: [`${n.reject.back_to}__in`],
        labels: [{ id: `${n.id}-reject-${n.reject.back_to}-kind`, text: 'reject' }],
      });
    }
  }

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.portConstraints': 'FIXED_SIDE',
      // Keep reject back-edges visually distinct by letting elkjs route them
      // through the side socket; with FIXED_SIDE it'll wrap around cleanly.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: elkNodes,
    edges: elkEdges,
  };

  const result = await elk.layout(graph);

  const nodes: LayoutNode[] = (result.children ?? []).map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width ?? NODE_WIDTH,
    height: c.height ?? NODE_HEIGHT,
  }));

  const edges: LayoutEdge[] = (result.edges ?? []).map((e: ElkEdge) => {
    const kind: EdgeKind = e.labels?.[0]?.text === 'reject' ? 'reject' : 'forward';
    const section = e.sections?.[0];
    const points: LayoutEdgePoint[] = section
      ? [
          { x: section.startPoint.x, y: section.startPoint.y },
          ...(section.bendPoints ?? []).map((p) => ({ x: p.x, y: p.y })),
          { x: section.endPoint.x, y: section.endPoint.y },
        ]
      : [];
    return {
      id: e.id,
      source: (e.sources?.[0] ?? '').split('__')[0]!,
      target: (e.targets?.[0] ?? '').split('__')[0]!,
      kind,
      points,
    };
  });

  return {
    nodes,
    edges,
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}

function portsForNode(n: WorkflowV2.WorkflowNode): NonNullable<ElkNode['ports']> {
  const base: NonNullable<ElkNode['ports']> = [
    { id: `${n.id}__in`, layoutOptions: { 'port.side': 'NORTH' } },
    { id: `${n.id}__out`, layoutOptions: { 'port.side': 'SOUTH' } },
  ];
  if (WorkflowV2.isReviewNode(n)) {
    base.push({ id: `${n.id}__reject`, layoutOptions: { 'port.side': 'EAST' } });
  }
  return base;
}

/** Port-anchor helper for the React renderer. Maps a port id back to a side. */
export function portSideOf(portId: string): PortSide {
  if (portId.endsWith('__in')) return 'NORTH';
  if (portId.endsWith('__out')) return 'SOUTH';
  if (portId.endsWith('__reject')) return 'EAST';
  return 'NORTH';
}
