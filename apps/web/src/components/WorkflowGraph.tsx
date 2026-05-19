// 4b.5 / 4b.6 — read-only workflow visualizer.
// 4h.11a — typed-edge rewrite.
//
// Takes the validated `def` the server broadcasts via `workflow-creator-draft`
// and stores via `pc_create_workflow`, plus the typed-edge map (4h.3) that
// captures structured wires (`@nodeId.field` / `@trigger.X` / `@env.NAME`).
// Renders the graph with react-flow.
//
// Layout: dagre auto-layout, left-to-right. Pan + zoom enabled, drag/edit
// disabled (4h.11b+ owns that).
//
// Edges = typed wires from the edges map + structural `depends_on` arrays.
// Each typed wire carries the source's output socket id + the consumer's
// input socket id, so react-flow draws between the right Handles. Env-var
// refs surface as a node-attached badge in the detail panel rather than a
// wire (no upstream node to wire from).
//
// Trigger nodes are synthetic — id `__trigger_on_enter` / `__trigger_callable`.
// Both can coexist on the same graph. Per D76, multi-trigger workflows
// expose only the INTERSECTION of trigger outputs. The synthetic node's
// outputs come from TRIGGER_OUTPUTS.
//
// Click a node → side panel renders read-only field detail. SDR-mode by
// default; edit-mode lands in 4h.11b.

import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import {
  Bot,
  Code,
  Edit3,
  Eye,
  FileText,
  Globe,
  Paperclip,
  PhoneIncoming,
  Play,
  PlusSquare,
  Repeat,
  ShieldCheck,
  Terminal,
  Workflow as WorkflowIcon,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

import type {
  CatalogType,
  EdgeRef,
  NodeEdges,
  Workflow,
  WfDagNode as DagNode,
  WorkflowEdges,
} from '@/api/client';
import {
  TRIGGER_OUTPUTS,
  TYPE_COLOR_BG,
  WEB_NODE_PORTS,
  type WebPortSpec,
} from '@/lib/workflow-ports';

interface WorkflowGraphProps {
  workflow: Workflow | null;
  /** Typed-edge map (4h). Keyed by node id; missing entries → node has no
   *  typed wires (only literal body fields). Null when the caller hasn't
   *  fetched edges yet — viewer renders nodes but skips wire edges. */
  edges?: WorkflowEdges | null;
}

// ── node-kind visual config ─────────────────────────────────────────────────
//
// One config row per kind from packages/domain/src/workflow.ts. The band
// classes follow the semantic-color tokens used elsewhere in the app — see
// `feedback_ui_visible_feedback`. The trigger configs share the band with
// `subagent`-like accent because they're entry points, not actions.

type KindKey = DagNode['kind'] | 'trigger-on-enter' | 'trigger-callable';

interface KindConfig {
  label: string;
  icon: LucideIcon;
  band: string; // tailwind classes for the colored band along the top of the node
}

const KIND_CONFIG: Record<KindKey, KindConfig> = {
  subagent: { label: 'subagent', icon: Bot, band: 'bg-primary/70' },
  bash: { label: 'bash', icon: Terminal, band: 'bg-foreground/60' },
  script: { label: 'script', icon: Code, band: 'bg-foreground/60' },
  http: { label: 'http', icon: Globe, band: 'bg-foreground/60' },
  approval: { label: 'approval', icon: ShieldCheck, band: 'bg-warning' },
  'orchestrator-review': { label: 'orchestrator-review', icon: Eye, band: 'bg-warning' },
  cancel: { label: 'cancel', icon: XCircle, band: 'bg-destructive' },
  workflow: { label: 'workflow', icon: WorkflowIcon, band: 'bg-info' },
  loop: { label: 'loop', icon: Repeat, band: 'bg-info' },
  'attach-to-work-item': { label: 'attach-to-work-item', icon: Paperclip, band: 'bg-success/70' },
  'create-work-item': { label: 'create-work-item', icon: PlusSquare, band: 'bg-success/70' },
  'update-work-item': { label: 'update-work-item', icon: Edit3, band: 'bg-success/70' },
  'write-to-worktree': { label: 'write-to-worktree', icon: FileText, band: 'bg-muted-foreground/60' },
  'trigger-on-enter': { label: 'on_enter', icon: Play, band: 'bg-success' },
  'trigger-callable': { label: 'callable', icon: PhoneIncoming, band: 'bg-success' },
};

// ── custom node component ───────────────────────────────────────────────────
//
// Single shell, parameterized by kind. The visual treatment per-kind comes
// from KIND_CONFIG. Selected state thickens the border so a click read is
// obvious without re-arranging the layout.

interface WorkflowNodeData extends Record<string, unknown> {
  kind: KindKey;
  title: string; // step id, or stage id for triggers
  subtitle?: string; // agent name for subagents, etc.
  /** Output sockets to render on the right edge. Determined per kind from the
   *  port-schema mirror + (for subagent) the author-declared output_schema. */
  outputs: ReadonlyArray<{ name: string; type: CatalogType }>;
  /** Input sockets to render on the left edge. Combines fixed input ports
   *  with `wire:` block keys; the structured edge map keys both kinds the
   *  same way (`in-<name>` for fixed ports, `wire-<name>` for wires). */
  inputs: ReadonlyArray<{ id: string; name: string; type: CatalogType; isWire: boolean }>;
}

// Vertical layout constants for socket rendering.
// Header band height (band + title + subtitle padding); first socket lives
// inside the body just below the band.
const HEADER_H = 64;
const SOCKET_GAP = 22;
const SOCKET_FIRST_OFFSET = 16; // from HEADER_H to first socket center
const FOOTER_PAD = 16;

function socketY(index: number): number {
  return HEADER_H + SOCKET_FIRST_OFFSET + index * SOCKET_GAP;
}

function nodeBodyHeight(socketCount: number): number {
  if (socketCount === 0) return HEADER_H + 28;
  return socketY(socketCount - 1) + FOOTER_PAD;
}

function WorkflowNode({ data, selected }: NodeProps<Node<WorkflowNodeData>>) {
  const cfg = KIND_CONFIG[data.kind];
  const Icon = cfg.icon;
  const socketCount = Math.max(data.inputs.length, data.outputs.length);
  const totalH = nodeBodyHeight(socketCount);
  return (
    <div
      className={
        'relative w-[220px] border bg-card text-foreground shadow-sm ' +
        (selected ? 'border-primary ring-1 ring-primary' : 'border-border')
      }
      style={{ height: totalH }}
    >
      <div className={'flex items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-background ' + cfg.band}>
        <Icon size={12} />
        <span className="font-medium">{cfg.label}</span>
      </div>
      <div className="px-3 py-2">
        <div className="break-words text-xs font-medium text-foreground">{data.title}</div>
        {data.subtitle && (
          <div className="mt-0.5 break-words text-[10px] text-muted-foreground">{data.subtitle}</div>
        )}
      </div>
      {/* Input sockets — left edge, one Handle per port + wire entry. SDR
       *  view: hover-only labels (per D79). Visual polish punted to the
       *  4h.11a-followup backlog item; functionality is intact (wires draw
       *  to/from the correct Y positions, drag-to-wire in 4h.11c will
       *  exercise this). */}
      {data.inputs.map((p, i) => (
        <Handle
          key={`tgt-${p.id}`}
          type="target"
          id={p.id}
          position={Position.Left}
          title={`${p.name} : ${p.type}`}
          className={`!h-3 !w-3 !border-2 !border-background ${TYPE_COLOR_BG[p.type]}`}
          style={{ top: socketY(i) }}
        />
      ))}
      {data.outputs.map((p, i) => (
        <Handle
          key={`src-${p.name}`}
          type="source"
          id={`out-${p.name}`}
          position={Position.Right}
          title={`${p.name} : ${p.type}`}
          className={`!h-3 !w-3 !border-2 !border-background ${TYPE_COLOR_BG[p.type]}`}
          style={{ top: socketY(i) }}
        />
      ))}
    </div>
  );
}

const NODE_TYPES = { workflowNode: WorkflowNode };

// ── typed-edge reference extraction ─────────────────────────────────────────
//
// Pre-4h.11a we walked every string-valued field for `$<id>.output` /
// `$inputs.<key>` tokens via regex. Post-4h, the typed-edge map carries
// structured wires; this helper re-shapes them into the detail panel's
// existing data contract (set of upstream node ids + trigger / env flags +
// the raw EdgeRef list for richer surfacing).

interface NodeRefs {
  /** Set of upstream node ids this consumer reads from. */
  fromSteps: Set<string>;
  /** True if the consumer reads from any trigger output. */
  fromTrigger: boolean;
  /** Set of env var names referenced. */
  fromEnv: Set<string>;
  /** All typed wires (input ports + template wires) keyed by consumer-side
   *  socket id (`in-<port>` or `wire-<localName>`). */
  wires: Array<{ consumerSocket: string; localName: string; ref: EdgeRef }>;
}

function extractRefs(node: DagNode, edges: WorkflowEdges | null | undefined): NodeRefs {
  const fromSteps = new Set<string>();
  const fromEnv = new Set<string>();
  let fromTrigger = false;
  const wires: NodeRefs['wires'] = [];
  const ne: NodeEdges | undefined = edges?.[node.id];
  if (ne?.inputs) {
    for (const [port, ref] of Object.entries(ne.inputs)) {
      wires.push({ consumerSocket: `in-${port}`, localName: port, ref });
      if (ref.kind === 'node' && ref.nodeId !== node.id) fromSteps.add(ref.nodeId);
      else if (ref.kind === 'trigger') fromTrigger = true;
      else if (ref.kind === 'env') fromEnv.add(ref.name);
    }
  }
  if (ne?.wire) {
    for (const [name, ref] of Object.entries(ne.wire)) {
      wires.push({ consumerSocket: `wire-${name}`, localName: name, ref });
      if (ref.kind === 'node' && ref.nodeId !== node.id) fromSteps.add(ref.nodeId);
      else if (ref.kind === 'trigger') fromTrigger = true;
      else if (ref.kind === 'env') fromEnv.add(ref.name);
    }
  }
  return { fromSteps, fromTrigger, fromEnv, wires };
}

// ── per-node port resolution ────────────────────────────────────────────────
//
// Output port list for a real DagNode. `fixed` kinds use the static schema;
// `subagent` reads its author-declared `output_schema`; `workflow` (nested)
// gets a placeholder single output that's wired by hand in v2.

function outputsForNode(
  node: DagNode,
  edges: WorkflowEdges | null | undefined,
): Array<{ name: string; type: CatalogType }> {
  const schema = WEB_NODE_PORTS[node.kind];
  if (schema.outputs.mode === 'fixed') {
    return schema.outputs.ports.map((p) => ({ name: p.name, type: p.type }));
  }
  if (schema.outputs.mode === 'author-declared') {
    const declared = edges?.[node.id]?.output_schema;
    if (!declared) return [];
    return Object.entries(declared).map(([name, type]) => ({ name, type }));
  }
  // nested-workflow: render a single placeholder output. Full resolution of
  // the called workflow's outputs lives in v2 (4h.11b/c).
  return [{ name: 'output', type: 'object' }];
}

function inputsForNode(
  node: DagNode,
  edges: WorkflowEdges | null | undefined,
): Array<{ id: string; name: string; type: CatalogType; isWire: boolean }> {
  const schema = WEB_NODE_PORTS[node.kind];
  const list: Array<{ id: string; name: string; type: CatalogType; isWire: boolean }> = [];
  if (schema.inputs.mode === 'fixed') {
    for (const p of schema.inputs.ports as ReadonlyArray<WebPortSpec>) {
      list.push({ id: `in-${p.name}`, name: p.name, type: p.type, isWire: false });
    }
  }
  // Wire-block entries are sockets too. Type for wire sockets is `text` —
  // template fields are strings that get interpolated; the upstream type
  // doesn't matter for compatibility at this layer (the runtime stringifies).
  const ne = edges?.[node.id];
  if (ne?.wire) {
    for (const name of Object.keys(ne.wire)) {
      list.push({ id: `wire-${name}`, name, type: 'text', isWire: true });
    }
  }
  return list;
}

function triggerOutputsFor(wf: Workflow): Array<{ name: string; type: CatalogType }> {
  // Multi-trigger intersection per D76. Today we have two trigger kinds —
  // on_enter and callable. Compute the union when only one is active, the
  // intersection when both are.
  const active: Array<ReadonlyArray<{ name: string; type: CatalogType }>> = [];
  if (wf.triggers?.on_enter?.stage_id) active.push(TRIGGER_OUTPUTS.on_enter);
  if (wf.triggers?.callable === true) active.push(TRIGGER_OUTPUTS.callable);
  if (active.length === 0) return [];
  if (active.length === 1) return [...active[0]!];
  // Intersection by name; type is stable across triggers (catalog-driven).
  const byName = new Map(active[0]!.map((p) => [p.name, p]));
  for (let i = 1; i < active.length; i++) {
    const next = new Map<string, { name: string; type: CatalogType }>();
    for (const p of active[i]!) {
      if (byName.has(p.name)) next.set(p.name, p);
    }
    byName.clear();
    for (const [k, v] of next) byName.set(k, v);
  }
  return [...byName.values()];
}

// ── dagre layout ────────────────────────────────────────────────────────────

const NODE_W = 220;

function layout(nodes: Node<WorkflowNodeData>[], edges: Edge[]): Node<WorkflowNodeData>[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const socketCount = Math.max(n.data.inputs.length, n.data.outputs.length);
    g.setNode(n.id, { width: NODE_W, height: nodeBodyHeight(socketCount) });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    const socketCount = Math.max(n.data.inputs.length, n.data.outputs.length);
    const h = nodeBodyHeight(socketCount);
    return {
      ...n,
      position: { x: pos.x - NODE_W / 2, y: pos.y - h / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });
}

// ── workflow → rf nodes + edges ─────────────────────────────────────────────

const TRIGGER_ON_ENTER_ID = '__trigger_on_enter';
const TRIGGER_CALLABLE_ID = '__trigger_callable';

function buildGraph(
  wf: Workflow,
  edgesMap: WorkflowEdges | null | undefined,
): { nodes: Node<WorkflowNodeData>[]; edges: Edge[] } {
  const wfNodes = wf.nodes ?? [];
  const triggerOnEnter = wf.triggers?.on_enter?.stage_id ?? null;
  const triggerCallable = wf.triggers?.callable === true;

  const triggerOuts = triggerOutputsFor(wf);
  // Single synthetic trigger root per D76 ("When this workflow runs"). When
  // multiple trigger kinds are active, the intersection of their outputs
  // becomes the root's socket list — but visually we collapse to one node
  // labelled with whichever trigger is present.
  const triggerId: string | null = triggerOnEnter
    ? TRIGGER_ON_ENTER_ID
    : triggerCallable
      ? TRIGGER_CALLABLE_ID
      : null;
  const triggerKind: KindKey =
    triggerOnEnter && triggerCallable
      ? 'trigger-on-enter'
      : triggerOnEnter
        ? 'trigger-on-enter'
        : 'trigger-callable';
  const triggerSubtitle =
    triggerOnEnter && triggerCallable
      ? `on stage enter · also callable`
      : triggerOnEnter
        ? 'on stage enter'
        : 'orchestrator-invoked';

  const nodes: Node<WorkflowNodeData>[] = [];

  if (triggerId) {
    nodes.push({
      id: triggerId,
      type: 'workflowNode',
      position: { x: 0, y: 0 },
      data: {
        kind: triggerKind,
        title: triggerOnEnter ?? 'callable',
        subtitle: triggerSubtitle,
        outputs: triggerOuts,
        inputs: [],
      } satisfies WorkflowNodeData,
      selectable: false,
    });
  }

  const realIds = new Set(wfNodes.map((n) => n.id));
  for (const n of wfNodes) {
    nodes.push({
      id: n.id,
      type: 'workflowNode',
      position: { x: 0, y: 0 },
      data: {
        kind: n.kind,
        title: n.id,
        subtitle: nodeSubtitle(n),
        outputs: outputsForNode(n, edgesMap),
        inputs: inputsForNode(n, edgesMap),
      } satisfies WorkflowNodeData,
    });
  }

  // Edges keyed by `${source}:${sourceHandle}->${target}:${targetHandle}` so a
  // single producer/consumer pair can carry multiple wires across different
  // sockets without collisions.
  const edgeMap = new Map<string, Edge>();
  const addWireEdge = (
    source: string,
    sourceHandle: string,
    target: string,
    targetHandle: string,
  ) => {
    const key = `${source}:${sourceHandle}->${target}:${targetHandle}`;
    if (edgeMap.has(key)) return;
    edgeMap.set(key, {
      id: `e-${key}`,
      source,
      sourceHandle,
      target,
      targetHandle,
      animated: false,
      data: { kind: 'ref' },
    });
  };
  const addDepEdge = (source: string, target: string) => {
    const key = `${source}:__dep->${target}:__dep`;
    if (edgeMap.has(key)) return;
    edgeMap.set(key, {
      id: `e-${key}`,
      source,
      target,
      animated: false,
      data: { kind: 'dep' },
      style: { strokeDasharray: '4 3', stroke: 'var(--color-muted-foreground)' },
    });
  };

  // 1) Typed wires from edges map (4h structured edges).
  for (const n of wfNodes) {
    const refs = extractRefs(n, edgesMap);
    for (const w of refs.wires) {
      if (w.ref.kind === 'node' && realIds.has(w.ref.nodeId)) {
        addWireEdge(w.ref.nodeId, `out-${w.ref.output}`, n.id, w.consumerSocket);
      } else if (w.ref.kind === 'trigger' && triggerId) {
        addWireEdge(triggerId, `out-${w.ref.output}`, n.id, w.consumerSocket);
      }
      // env refs render as side-panel badges, not wires.
    }
  }

  // 2) Structural `depends_on` arrays (legacy ordering hint).
  for (const n of wfNodes) {
    for (const dep of n.depends_on ?? []) {
      if (realIds.has(dep)) addDepEdge(dep, n.id);
    }
  }

  // 3) Entry-point hook: any real node with no incoming edge gets a dep edge
  //    from the trigger node. Keeps disconnected nodes visually tied to the
  //    entry point until the author wires them.
  if (triggerId) {
    const consumed = new Set<string>();
    for (const e of edgeMap.values()) consumed.add(e.target);
    for (const n of wfNodes) {
      if (!consumed.has(n.id)) addDepEdge(triggerId, n.id);
    }
  }

  const edges = [...edgeMap.values()];
  return { nodes: layout(nodes, edges), edges };
}

function nodeSubtitle(n: DagNode): string | undefined {
  switch (n.kind) {
    case 'subagent':
      return n.subagent;
    case 'http':
      return `${n.http.method} ${n.http.url}`;
    case 'script':
      return n.runtime;
    case 'workflow':
      return `→ ${n.workflow}`;
    case 'attach-to-work-item':
      return n['attach-to-work-item'].name;
    case 'create-work-item':
      return n['create-work-item'].title;
    case 'update-work-item':
      return n['update-work-item'].workItemId;
    case 'write-to-worktree':
      return n['write-to-worktree'].path;
    case 'cancel':
      return n.cancel;
    case 'approval':
      return n.approval.message;
    case 'orchestrator-review':
      return n['orchestrator-review'].prompt.slice(0, 80);
    case 'loop':
      return `body: ${n.loop.body.length} step${n.loop.body.length === 1 ? '' : 's'}`;
    case 'bash':
      return n.bash.split('\n')[0]?.slice(0, 60);
    default:
      return undefined;
  }
}

// ── component ───────────────────────────────────────────────────────────────

export function WorkflowGraph({ workflow, edges: edgesMap }: WorkflowGraphProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    if (!workflow) return { nodes: [] as Node<WorkflowNodeData>[], edges: [] as Edge[] };
    return buildGraph(workflow, edgesMap ?? null);
  }, [workflow, edgesMap]);

  // drop the selection when the underlying graph drops the node (eg the
  // interview deleted/renamed a step). Otherwise the panel sticks open with
  // stale content.
  useEffect(() => {
    if (selectedId && !nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [nodes, selectedId]);

  const selectedNode = useMemo(() => {
    if (!workflow || !selectedId) return null;
    if (selectedId === TRIGGER_ON_ENTER_ID || selectedId === TRIGGER_CALLABLE_ID) return null;
    return workflow.nodes.find((n) => n.id === selectedId) ?? null;
  }, [workflow, selectedId]);

  if (!workflow || workflow.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-background/40 p-6 text-center">
        <p className="max-w-sm text-xs italic text-muted-foreground">
          Draft will appear here as the interview progresses.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-background/40">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnDrag
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>

      {selectedNode && (
        <NodeDetailPanel
          node={selectedNode}
          workflow={workflow}
          edges={edgesMap ?? null}
          onClose={() => setSelectedId(null)}
          onJumpToNode={(id) => setSelectedId(id)}
        />
      )}
    </div>
  );
}

// ── click-node detail panel (4b.6) ──────────────────────────────────────────

function NodeDetailPanel({
  node,
  workflow,
  edges,
  onClose,
  onJumpToNode,
}: {
  node: DagNode;
  workflow: Workflow;
  edges: WorkflowEdges | null;
  onClose: () => void;
  onJumpToNode: (id: string) => void;
}) {
  const cfg = KIND_CONFIG[node.kind];
  const Icon = cfg.icon;
  const refs = useMemo(() => extractRefs(node, edges), [node, edges]);

  return (
    <aside className="absolute right-3 top-3 bottom-3 z-10 flex w-[320px] max-w-[60%] flex-col border border-border bg-card text-xs shadow-xl">
      <header className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon size={14} />
          <div>
            <div className="font-mono text-xs font-medium text-foreground">{node.id}</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{cfg.label}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close node detail"
          className="border border-border px-2 py-0.5 text-[10px] hover:bg-muted"
        >
          Close
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        <FieldList node={node} />
        <ReferencesSection
          refs={refs}
          workflow={workflow}
          onJumpToNode={onJumpToNode}
        />
        {(node.depends_on?.length ?? 0) > 0 && (
          <DependsOnSection node={node} workflow={workflow} onJumpToNode={onJumpToNode} />
        )}
        {node.when && (
          <DetailRow label="when">
            <code className="break-all text-[10px]">{node.when}</code>
          </DetailRow>
        )}
        {node.trigger_rule && (
          <DetailRow label="trigger_rule">
            <span className="text-[11px]">{node.trigger_rule}</span>
          </DetailRow>
        )}
        {node.timeout !== undefined && (
          <DetailRow label="timeout">
            <span className="text-[11px]">{node.timeout} ms</span>
          </DetailRow>
        )}
        {node.retry && (
          <DetailRow label="retry">
            <span className="text-[11px]">
              max {node.retry.max_attempts}
              {node.retry.delay_ms ? ` · ${node.retry.delay_ms}ms delay` : ''}
              {node.retry.on?.length ? ` · on ${node.retry.on.join(',')}` : ''}
            </span>
          </DetailRow>
        )}
      </div>
    </aside>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="break-words text-foreground">{children}</div>
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-all border border-border bg-background/60 p-2 font-mono text-[11px] text-foreground">
      {text}
    </pre>
  );
}

function FieldList({ node }: { node: DagNode }) {
  switch (node.kind) {
    case 'subagent':
      return (
        <>
          <DetailRow label="subagent">
            <span className="font-mono">{node.subagent}</span>
          </DetailRow>
          <DetailRow label="prompt">
            <CodeBlock text={node.prompt} />
          </DetailRow>
        </>
      );
    case 'bash':
      return (
        <DetailRow label="bash">
          <CodeBlock text={node.bash} />
        </DetailRow>
      );
    case 'http':
      return (
        <>
          <DetailRow label="method">
            <span className="font-mono">{node.http.method}</span>
          </DetailRow>
          <DetailRow label="url">
            <code className="break-all text-[10px]">{node.http.url}</code>
          </DetailRow>
          {node.http.headers && Object.keys(node.http.headers).length > 0 && (
            <DetailRow label="headers">
              <CodeBlock
                text={Object.entries(node.http.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
              />
            </DetailRow>
          )}
          {node.http.body && (
            <DetailRow label="body">
              <CodeBlock text={node.http.body} />
            </DetailRow>
          )}
          {node.http.timeout !== undefined && (
            <DetailRow label="http.timeout">
              <span>{node.http.timeout} ms</span>
            </DetailRow>
          )}
        </>
      );
    case 'script':
      return (
        <>
          <DetailRow label="runtime">
            <span className="font-mono">{node.runtime}</span>
          </DetailRow>
          <DetailRow label="script">
            <CodeBlock text={node.script} />
          </DetailRow>
        </>
      );
    case 'approval':
      return (
        <>
          <DetailRow label="message">{node.approval.message}</DetailRow>
          {node.approval.on_reject?.prompt && (
            <DetailRow label="on_reject.prompt">{node.approval.on_reject.prompt}</DetailRow>
          )}
        </>
      );
    case 'orchestrator-review':
      return (
        <>
          <DetailRow label="prompt">
            <CodeBlock text={node['orchestrator-review'].prompt} />
          </DetailRow>
          {node['orchestrator-review'].artifact && (
            <DetailRow label="artifact">
              <code className="break-all text-[10px]">{node['orchestrator-review'].artifact}</code>
            </DetailRow>
          )}
          {node['orchestrator-review'].on_revise?.prompt && (
            <DetailRow label="on_revise.prompt">{node['orchestrator-review'].on_revise.prompt}</DetailRow>
          )}
        </>
      );
    case 'cancel':
      return <DetailRow label="reason">{node.cancel}</DetailRow>;
    case 'workflow':
      return (
        <>
          <DetailRow label="workflow">
            <span className="font-mono">{node.workflow}</span>
          </DetailRow>
          {node.inputs && Object.keys(node.inputs).length > 0 && (
            <DetailRow label="inputs">
              <CodeBlock
                text={Object.entries(node.inputs)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
              />
            </DetailRow>
          )}
        </>
      );
    case 'loop':
      return (
        <>
          <DetailRow label="until">
            <code className="break-all text-[10px]">{node.loop.until}</code>
          </DetailRow>
          <DetailRow label="max_iterations">{node.loop.max_iterations}</DetailRow>
          <DetailRow label="body">
            <div className="flex flex-col gap-1">
              {node.loop.body.map((child) => (
                <div
                  key={child.id}
                  className="flex items-center justify-between border border-border bg-background/60 px-2 py-1"
                >
                  <span className="font-mono text-[11px]">{child.id}</span>
                  <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {child.kind}
                  </span>
                </div>
              ))}
            </div>
          </DetailRow>
        </>
      );
    case 'attach-to-work-item': {
      const a = node['attach-to-work-item'];
      return (
        <>
          <DetailRow label="workItemId">
            <code className="break-all text-[10px]">{a.workItemId}</code>
          </DetailRow>
          <DetailRow label="name">{a.name}</DetailRow>
          <DetailRow label="content">
            <CodeBlock text={a.content} />
          </DetailRow>
          {a.kind && <DetailRow label="kind">{a.kind}</DetailRow>}
          {a.contentType && <DetailRow label="contentType">{a.contentType}</DetailRow>}
        </>
      );
    }
    case 'create-work-item': {
      const c = node['create-work-item'];
      return (
        <>
          <DetailRow label="title">{c.title}</DetailRow>
          {c.body && (
            <DetailRow label="body">
              <CodeBlock text={c.body} />
            </DetailRow>
          )}
          {c.stage && <DetailRow label="stage">{c.stage}</DetailRow>}
          {c.parentId && (
            <DetailRow label="parentId">
              <code className="break-all text-[10px]">{c.parentId}</code>
            </DetailRow>
          )}
        </>
      );
    }
    case 'update-work-item': {
      const u = node['update-work-item'];
      return (
        <>
          <DetailRow label="workItemId">
            <code className="break-all text-[10px]">{u.workItemId}</code>
          </DetailRow>
          {u.title && <DetailRow label="title">{u.title}</DetailRow>}
          {u.body && (
            <DetailRow label="body">
              <CodeBlock text={u.body} />
            </DetailRow>
          )}
          {u.stage && <DetailRow label="stage">{u.stage}</DetailRow>}
          {u.fields && (
            <DetailRow label="fields">
              <CodeBlock text={JSON.stringify(u.fields, null, 2)} />
            </DetailRow>
          )}
        </>
      );
    }
    case 'write-to-worktree': {
      const w = node['write-to-worktree'];
      return (
        <>
          <DetailRow label="path">
            <code className="break-all text-[10px]">{w.path}</code>
          </DetailRow>
          {w.mode && <DetailRow label="mode">{w.mode}</DetailRow>}
          <DetailRow label="content">
            <CodeBlock text={w.content} />
          </DetailRow>
        </>
      );
    }
    default:
      return null;
  }
}

function ReferencesSection({
  refs,
  workflow,
  onJumpToNode,
}: {
  refs: NodeRefs;
  workflow: Workflow;
  onJumpToNode: (id: string) => void;
}) {
  const hasAny =
    refs.fromSteps.size > 0 || refs.fromTrigger || refs.fromEnv.size > 0;
  if (!hasAny) return null;
  const known = new Set(workflow.nodes.map((n) => n.id));
  return (
    <DetailRow label="reads from">
      <div className="flex flex-wrap gap-1">
        {refs.fromTrigger && (
          <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            @trigger
          </span>
        )}
        {[...refs.fromEnv].map((name) => (
          <span
            key={`env-${name}`}
            className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
            title={`Environment variable: ${name}`}
          >
            @env.{name}
          </span>
        ))}
        {[...refs.fromSteps].map((id) => {
          const exists = known.has(id);
          return (
            <button
              key={id}
              type="button"
              disabled={!exists}
              onClick={() => exists && onJumpToNode(id)}
              className={
                'border border-border px-1.5 py-0.5 text-[10px] font-mono ' +
                (exists ? 'hover:bg-muted' : 'text-destructive')
              }
              title={exists ? `Jump to ${id}` : `Unknown step: ${id}`}
            >
              @{id}
            </button>
          );
        })}
      </div>
    </DetailRow>
  );
}

function DependsOnSection({
  node,
  workflow,
  onJumpToNode,
}: {
  node: DagNode;
  workflow: Workflow;
  onJumpToNode: (id: string) => void;
}) {
  const known = new Set(workflow.nodes.map((n) => n.id));
  return (
    <DetailRow label="depends_on">
      <div className="flex flex-wrap gap-1">
        {(node.depends_on ?? []).map((id) => {
          const exists = known.has(id);
          return (
            <button
              key={id}
              type="button"
              disabled={!exists}
              onClick={() => exists && onJumpToNode(id)}
              className={
                'border border-border px-1.5 py-0.5 text-[10px] font-mono ' +
                (exists ? 'hover:bg-muted' : 'text-destructive')
              }
              title={exists ? `Jump to ${id}` : `Unknown step: ${id}`}
            >
              {id}
            </button>
          );
        })}
      </div>
    </DetailRow>
  );
}
