// Section 19.8 — v2 workflow visualizer (rebuild from scratch).
//
// Renders a WorkflowV2.Workflow as a top-to-bottom DAG. Layout comes from
// elkjs via lib/workflow-layout.ts (orthogonal routing, one-socket-per-side).
//
// v1 surface (apps/web/src/components/WorkflowGraph.tsx) stays untouched until
// 19.12 culls it. Both can coexist.
//
// What's here (19.8.2 — read-only render):
//   - Top-to-bottom layout, pan via wheel + drag-on-empty-space.
//   - HTML node tiles overlaid on SVG edges.
//   - Forward `next` edges (solid) + reject back-edges (dashed/curved).
//   - Per-kind visual treatment for agent / bash / script / human-review /
//     orchestrator-review.
//
// What lands next:
//   - 19.8.3: runtime overlay (state vocabulary + active-edge animation).
//   - 19.8.4: authoring mode (drag-to-move + drag-to-wire).

import { useEffect, useMemo, useRef, useState } from 'react';
import { WorkflowV2 } from '@pc/domain';
import {
  Bot,
  Check,
  Eye,
  ShieldCheck,
  Terminal,
  Code,
  X,
  type LucideIcon,
} from 'lucide-react';

import {
  layoutWorkflow,
  type LayoutResult,
  type LayoutEdge,
  NODE_WIDTH,
  NODE_HEIGHT,
} from '@/lib/workflow-layout';

interface KindConfig {
  label: string;
  icon: LucideIcon;
  band: string;
}

const KIND_CONFIG: Record<WorkflowV2.WorkflowNode['kind'], KindConfig> = {
  agent: { label: 'agent', icon: Bot, band: 'bg-primary/70' },
  bash: { label: 'bash', icon: Terminal, band: 'bg-foreground/60' },
  script: { label: 'script', icon: Code, band: 'bg-foreground/60' },
  'human-review': { label: 'human-review', icon: ShieldCheck, band: 'bg-warning' },
  'orchestrator-review': { label: 'orchestrator-review', icon: Eye, band: 'bg-warning' },
};

export interface WorkflowGraphV2Props {
  workflow: WorkflowV2.Workflow | null;
  /** Optional runtime DAG state for the overlay vocabulary. v1: ignored.
   *  Wired in 19.8.3. */
  runState?: WorkflowV2.WorkflowDagState | null;
  /** Optional node-click callback. */
  onNodeClick?: (node: WorkflowV2.WorkflowNode) => void;
}

export function WorkflowGraphV2({
  workflow,
  runState,
  onNodeClick,
}: WorkflowGraphV2Props) {
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // Re-layout when the workflow structure changes.
  const layoutKey = useMemo(
    () =>
      workflow
        ? JSON.stringify({
            id: workflow.id,
            nodes: workflow.nodes.map((n) => ({
              id: n.id,
              kind: n.kind,
              next: n.next ?? [],
              reject: WorkflowV2.isReviewNode(n) ? n.reject?.back_to ?? null : null,
            })),
          })
        : '',
    [workflow],
  );

  useEffect(() => {
    let cancelled = false;
    if (!workflow) {
      setLayout(null);
      return undefined;
    }
    void layoutWorkflow(workflow).then((res) => {
      if (!cancelled) setLayout(res);
    });
    return () => {
      cancelled = true;
    };
  }, [layoutKey, workflow]);

  if (!workflow) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground text-sm">
        No workflow selected.
      </div>
    );
  }
  if (!layout) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground text-sm">
        Laying out…
      </div>
    );
  }

  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));
  const runningIds = new Set<string>();
  if (runState) {
    for (const [id, rec] of Object.entries(runState.nodes)) {
      if (rec.state === 'running') runningIds.add(id);
    }
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-background"
      onMouseDown={(e) => {
        // Pan only when dragging on empty canvas, not on a node tile.
        if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest('[data-graph-bg]')) {
          return;
        }
        dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      }}
      onMouseMove={(e) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.x;
        const dy = e.clientY - dragRef.current.y;
        setPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy });
      }}
      onMouseUp={() => {
        dragRef.current = null;
      }}
      onMouseLeave={() => {
        dragRef.current = null;
      }}
    >
      <div
        data-graph-bg
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, hsl(var(--muted-foreground) / 0.15) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />
      <div
        className="absolute top-0 left-0"
        style={{
          transform: `translate(${String(pan.x + 24)}px, ${String(pan.y + 24)}px)`,
          width: layout.width,
          height: layout.height,
        }}
      >
        <svg
          className="absolute top-0 left-0 pointer-events-none"
          width={layout.width}
          height={layout.height}
          style={{ overflow: 'visible' }}
        >
          {layout.edges.map((edge) => (
            <EdgePath
              key={edge.id}
              edge={edge}
              isActive={runningIds.has(edge.target)}
            />
          ))}
        </svg>
        {layout.nodes.map((ln) => {
          const node = nodeById.get(ln.id);
          if (!node) return null;
          const nodeState = runState?.nodes[ln.id]?.state ?? null;
          const iteration = runState?.nodes[ln.id]?.iteration;
          return (
            <NodeTile
              key={ln.id}
              node={node}
              x={ln.x}
              y={ln.y}
              state={nodeState}
              iteration={iteration ?? null}
              onClick={onNodeClick ? () => onNodeClick(node) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

function EdgePath({ edge, isActive }: { edge: LayoutEdge; isActive: boolean }) {
  if (edge.points.length < 2) return null;
  const d = edge.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${String(p.x)} ${String(p.y)}`)
    .join(' ');
  const isReject = edge.kind === 'reject';
  const last = edge.points[edge.points.length - 1]!;
  const beforeLast = edge.points[edge.points.length - 2]!;
  const dx = last.x - beforeLast.x;
  const dy = last.y - beforeLast.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const arrowLen = 8;
  const arrowWid = 4;
  const ax = last.x - ux * arrowLen;
  const ay = last.y - uy * arrowLen;
  const px = -uy * arrowWid;
  const py = ux * arrowWid;
  const arrow = `M ${String(last.x)} ${String(last.y)} L ${String(ax + px)} ${String(
    ay + py,
  )} L ${String(ax - px)} ${String(ay - py)} Z`;

  const stroke = isActive
    ? 'hsl(var(--primary))'
    : isReject
      ? 'hsl(var(--warning))'
      : 'hsl(var(--foreground) / 0.6)';

  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={isActive ? 2 : 1.5}
        strokeDasharray={isActive ? '8 4' : isReject ? '6 4' : undefined}
        className={isActive ? 'animate-[dash_1.2s_linear_infinite]' : undefined}
      />
      <path d={arrow} fill={stroke} />
    </g>
  );
}

// Border + animation classes per lock 9 (runtime overlay vocabulary).
const STATE_BORDER: Record<WorkflowV2.NodeRunState, string> = {
  pending: 'border-muted-foreground/30',
  running: 'border-primary animate-pulse',
  completed: 'border-muted-foreground/20 opacity-70',
  failed: 'border-destructive',
  skipped: 'border-muted-foreground/20 opacity-40',
  'awaiting-review': 'border-warning',
};

function NodeTile({
  node,
  x,
  y,
  state,
  iteration,
  onClick,
}: {
  node: WorkflowV2.WorkflowNode;
  x: number;
  y: number;
  state: WorkflowV2.NodeRunState | null;
  iteration: number | null;
  onClick?: () => void;
}) {
  const cfg = KIND_CONFIG[node.kind];
  const Icon = cfg.icon;
  const subtitle = node.kind === 'agent' ? node.agent : null;
  const borderCls = state ? STATE_BORDER[state] : 'border-border';
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      className={
        'absolute border bg-card text-foreground shadow-sm rounded-md overflow-hidden ' +
        borderCls +
        ' ' +
        (onClick ? 'cursor-pointer hover:border-primary/60' : 'cursor-default')
      }
      style={{
        transform: `translate(${String(x)}px, ${String(y)}px)`,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }}
    >
      <div className={`h-1.5 w-full ${cfg.band}`} />
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium">{node.id}</div>
          <div className="truncate text-xs text-muted-foreground">
            {subtitle ?? cfg.label}
          </div>
        </div>
        <StateBadge state={state} iteration={iteration} />
      </div>
    </div>
  );
}

function StateBadge({
  state,
  iteration,
}: {
  state: WorkflowV2.NodeRunState | null;
  iteration: number | null;
}) {
  if (!state || state === 'pending') return null;
  if (state === 'completed') {
    return <Check className="h-4 w-4 shrink-0 text-success" />;
  }
  if (state === 'failed') {
    return <X className="h-4 w-4 shrink-0 text-destructive" />;
  }
  if (state === 'running') {
    return (
      <span className="text-xs text-primary">
        {iteration && iteration > 1 ? `run ${String(iteration)}` : 'running'}
      </span>
    );
  }
  if (state === 'awaiting-review') {
    return <Eye className="h-4 w-4 shrink-0 text-warning" />;
  }
  if (state === 'skipped') {
    return <span className="text-xs text-muted-foreground">skipped</span>;
  }
  return null;
}
