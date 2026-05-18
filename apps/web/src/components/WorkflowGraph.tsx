// 4b.5 / 4b.6 — read-only workflow visualizer.
//
// Phase B2 of the Workflow Builder UI. Takes a typed `Workflow` (the same
// validated `def` the server broadcasts via `workflow-creator-draft` and
// stores via `pc_create_workflow`) and renders the graph with react-flow.
//
// Layout: dagre auto-layout, left-to-right. Pan + zoom enabled, drag/edit
// disabled (v2 owns that).
//
// Edges = references + structural deps. We walk every string field of every
// node for `$<id>.output[.path]` and `$inputs.<key>` tokens, AND honor
// declared `depends_on` arrays. The two sources are de-duplicated per
// upstream→downstream pair; an edge exists if either source declares it.
// $inputs.* references draw an edge from whichever trigger source is active
// (on_enter / callable / first-of-the-two).
//
// Trigger nodes are synthetic — id `__trigger_on_enter` / `__trigger_callable`.
// Both can coexist on the same graph. When neither is set we still render the
// real nodes; the graph just floats without an explicit entry point.
//
// Click a node → side panel renders read-only field detail. No edit
// affordances; v2 promotes the panel to an editor.

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

import type { Workflow, WfDagNode as DagNode } from '@/api/client';

interface WorkflowGraphProps {
  workflow: Workflow | null;
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
}

function WorkflowNode({ data, selected }: NodeProps<Node<WorkflowNodeData>>) {
  const cfg = KIND_CONFIG[data.kind];
  const Icon = cfg.icon;
  return (
    <div
      className={
        'min-w-[180px] max-w-[260px] border bg-card text-foreground shadow-sm ' +
        (selected ? 'border-primary ring-1 ring-primary' : 'border-border')
      }
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border !border-border !bg-background" />
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
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border !border-border !bg-background" />
    </div>
  );
}

const NODE_TYPES = { workflowNode: WorkflowNode };

// ── reference + dep extraction ──────────────────────────────────────────────
//
// Walk every string-valued field on every node body and capture `$<id>.output`
// and `$inputs.<key>` tokens. Returned as a map keyed by consumer step id, so
// the edge builder can de-dupe against `depends_on`.

const STEP_REF_RE = /\$([a-zA-Z0-9_-]+)\.output\b/g;
const INPUTS_REF_RE = /\$inputs\.[a-zA-Z0-9_-]+/g;

interface NodeRefs {
  fromSteps: Set<string>;
  fromInputs: boolean;
}

function collectStrings(value: unknown, out: string[]) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

function extractRefs(node: DagNode): NodeRefs {
  const strings: string[] = [];
  collectStrings(node, strings);
  const fromSteps = new Set<string>();
  let fromInputs = false;
  for (const s of strings) {
    for (const m of s.matchAll(STEP_REF_RE)) {
      const id = m[1];
      if (id && id !== node.id) fromSteps.add(id);
    }
    if (INPUTS_REF_RE.test(s)) fromInputs = true;
    INPUTS_REF_RE.lastIndex = 0;
  }
  return { fromSteps, fromInputs };
}

// ── dagre layout ────────────────────────────────────────────────────────────

const NODE_W = 220;
const NODE_H = 80;

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 60, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      // anchor points so react-flow handles align with the dagre coords
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });
}

// ── workflow → rf nodes + edges ─────────────────────────────────────────────

const TRIGGER_ON_ENTER_ID = '__trigger_on_enter';
const TRIGGER_CALLABLE_ID = '__trigger_callable';

function buildGraph(wf: Workflow): { nodes: Node[]; edges: Edge[] } {
  const wfNodes = wf.nodes ?? [];
  const triggerOnEnter = wf.triggers?.on_enter?.stage_id ?? null;
  const triggerCallable = wf.triggers?.callable === true;

  const nodes: Node[] = [];

  if (triggerOnEnter) {
    nodes.push({
      id: TRIGGER_ON_ENTER_ID,
      type: 'workflowNode',
      position: { x: 0, y: 0 },
      data: {
        kind: 'trigger-on-enter',
        title: triggerOnEnter,
        subtitle: 'on stage enter',
      } satisfies WorkflowNodeData,
      selectable: false,
    });
  }
  if (triggerCallable) {
    nodes.push({
      id: TRIGGER_CALLABLE_ID,
      type: 'workflowNode',
      position: { x: 0, y: 0 },
      data: {
        kind: 'trigger-callable',
        title: 'callable',
        subtitle: 'orchestrator-invoked',
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
      } satisfies WorkflowNodeData,
    });
  }

  // de-duplicated edge set keyed `${source}->${target}`
  const edgeMap = new Map<string, Edge>();
  const addEdge = (source: string, target: string, kind: 'ref' | 'dep') => {
    const key = `${source}->${target}`;
    const existing = edgeMap.get(key);
    if (existing) {
      // ref wins over dep visually (it's the more informative edge)
      if (kind === 'ref') {
        existing.style = { ...existing.style, strokeDasharray: undefined };
        (existing.data as { kind: string }).kind = 'ref';
      }
      return;
    }
    edgeMap.set(key, {
      id: `e-${key}`,
      source,
      target,
      animated: false,
      data: { kind },
      style: kind === 'dep' ? { strokeDasharray: '4 3', stroke: 'var(--color-muted-foreground)' } : undefined,
    });
  };

  let inputsTriggerId: string | null = null;
  if (triggerOnEnter) inputsTriggerId = TRIGGER_ON_ENTER_ID;
  else if (triggerCallable) inputsTriggerId = TRIGGER_CALLABLE_ID;

  for (const n of wfNodes) {
    const refs = extractRefs(n);
    for (const upstream of refs.fromSteps) {
      if (realIds.has(upstream)) addEdge(upstream, n.id, 'ref');
    }
    if (refs.fromInputs && inputsTriggerId) addEdge(inputsTriggerId, n.id, 'ref');
    for (const dep of n.depends_on ?? []) {
      if (realIds.has(dep)) addEdge(dep, n.id, 'dep');
    }
  }

  // entry-point hook: any node with no incoming edge gets connected from the
  // first available trigger node. Skip if there's no trigger at all.
  if (inputsTriggerId) {
    const consumed = new Set<string>();
    for (const e of edgeMap.values()) consumed.add(e.target);
    for (const n of wfNodes) {
      if (!consumed.has(n.id)) addEdge(inputsTriggerId, n.id, 'dep');
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

export function WorkflowGraph({ workflow }: WorkflowGraphProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    if (!workflow) return { nodes: [] as Node[], edges: [] as Edge[] };
    return buildGraph(workflow);
  }, [workflow]);

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
  onClose,
  onJumpToNode,
}: {
  node: DagNode;
  workflow: Workflow;
  onClose: () => void;
  onJumpToNode: (id: string) => void;
}) {
  const cfg = KIND_CONFIG[node.kind];
  const Icon = cfg.icon;
  const refs = useMemo(() => extractRefs(node), [node]);

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
  if (refs.fromSteps.size === 0 && !refs.fromInputs) return null;
  const known = new Set(workflow.nodes.map((n) => n.id));
  return (
    <DetailRow label="reads from">
      <div className="flex flex-wrap gap-1">
        {refs.fromInputs && (
          <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            $inputs
          </span>
        )}
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
              ${id}.output
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
