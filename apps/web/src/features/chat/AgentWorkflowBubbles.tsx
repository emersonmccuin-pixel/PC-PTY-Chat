import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { TranscriptViewer } from '@/components/TranscriptViewer';
import type {
  SubagentFailureEvent,
  TaskEndEvent,
  TaskStartEvent,
  TodosEvent,
} from '@/features/runtime/ws-types';
import { useAgentTranscript } from '@/store/agent-transcript';
import {
  CollapsibleEventGroup,
  type EventGroupStatusTone,
} from '@/features/chat/ToolBubbles';
import type { AgentEventEntry, WorkflowEventEntry } from '@/features/chat/types';

const FAILURE_CAUSE_LABEL: Record<SubagentFailureEvent['cause'], string> = {
  'agent-self-failed': 'Agent reported failure',
  'agent-returned-without-closing': 'Agent did not close the node',
  'dispatch-error': 'Dispatch failed',
  timeout: 'Timed out',
};

export function FailureBubble({ event }: { event: SubagentFailureEvent }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  return (
    <div className="text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-destructive px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive-foreground">
          subagent failed
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{event.agentName}</span>
        <span className="text-[10px] text-muted-foreground">
          {FAILURE_CAUSE_LABEL[event.cause] ?? event.cause}
          {event.attemptNumber > 1 ? ` · attempt ${event.attemptNumber}` : ''}
        </span>
      </div>
      <div className="mb-1.5 whitespace-pre-wrap break-words text-sm text-foreground">
        {event.surfaceError || '(no surface error provided)'}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-mono">
          run={event.workflowRunId.slice(0, 12)} · node={event.nodeId}
        </span>
        {event.transcriptPath ? (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="border border-border px-2 py-0.5 text-[10px] hover:bg-muted"
          >
            View transcript
          </button>
        ) : (
          <span className="italic">no transcript captured</span>
        )}
      </div>
      {viewerOpen && event.transcriptPath && (
        <TranscriptViewer
          path={event.transcriptPath}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}

const WORKFLOW_TERMINATED_STATUS_RE = /status="(\w+)"/;

function deriveWorkflowStatus(events: WorkflowEventEntry[]):
  | { text: string; tone?: EventGroupStatusTone }
  | undefined {
  if (events.length === 0) return undefined;
  const last = events[events.length - 1]!;
  if (last.kind === 'terminated') {
    const m = last.body.match(WORKFLOW_TERMINATED_STATUS_RE);
    const s = m?.[1];
    if (s === 'complete') return { text: 'completed', tone: 'success' };
    if (s === 'failed') return { text: 'failed', tone: 'error' };
    if (s === 'cancelled') return { text: 'cancelled' };
    return { text: 'ended' };
  }
  if (last.kind === 'orchestrator-review') return { text: 'awaiting review', tone: 'warning' };
  return { text: 'running', tone: 'warning' };
}

export function WorkflowRunGroupBubble({
  workflowRunId,
  events,
}: {
  workflowRunId: string;
  events: WorkflowEventEntry[];
}) {
  const [open, setOpen] = useState(false);
  const status = deriveWorkflowStatus(events);
  return (
    <CollapsibleEventGroup
      label="Workflow run"
      count={`${events.length} ${events.length === 1 ? 'event' : 'events'}`}
      status={status}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        run {workflowRunId}
      </div>
      {events.map((ev, i) => (
        <div key={i} className="border-l border-border pl-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {ev.kind}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {ev.body}
          </pre>
        </div>
      ))}
    </CollapsibleEventGroup>
  );
}

const AGENT_CAUSE_RE = /\[cause:\s*([\w-]+)\]/;
const AGENT_VERIFICATION_RE = /\[verification:\s*(\w+)\]/;

function deriveAgentStatus(events: AgentEventEntry[]):
  | { text: string; tone?: EventGroupStatusTone }
  | undefined {
  if (events.length === 0) return undefined;
  const last = events[events.length - 1]!;
  switch (last.kind) {
    case 'agent-completed': {
      const v = last.body.match(AGENT_VERIFICATION_RE)?.[1];
      if (v === 'failed') return { text: 'completed · verify failed', tone: 'error' };
      if (v === 'pending') return { text: 'completed · review pending', tone: 'warning' };
      return { text: 'completed', tone: 'success' };
    }
    case 'agent-failed': {
      const cause = last.body.match(AGENT_CAUSE_RE)?.[1];
      return { text: cause ? `failed (${cause})` : 'failed', tone: 'error' };
    }
    case 'agent-asks-orchestrator':
      return { text: 'awaiting orchestrator', tone: 'warning' };
    case 'agent-asks-user':
      return { text: 'awaiting user', tone: 'warning' };
    case 'agent-approval-request':
      return { text: 'awaiting approval', tone: 'warning' };
    case 'agent-queued-started':
      return { text: 'running', tone: 'warning' };
    default:
      return { text: 'running', tone: 'warning' };
  }
}

export function AgentDispatchGroupBubble({
  agentRunId,
  agentName,
  events,
}: {
  agentRunId: string;
  agentName: string | null;
  events: AgentEventEntry[];
}) {
  const [open, setOpen] = useState(false);
  const status = deriveAgentStatus(events);
  const label = agentName ? `Agent · ${agentName}` : 'Agent';
  const openTranscript = useAgentTranscript((s) => s.open);
  return (
    <CollapsibleEventGroup
      label={label}
      count={`${events.length} ${events.length === 1 ? 'event' : 'events'}`}
      status={status}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          run {agentRunId}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openTranscript(agentRunId);
          }}
          className="shrink-0 border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          View transcript
        </button>
      </div>
      {events.map((ev, i) => (
        <div key={i} className="border-l border-border pl-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {ev.kind}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {ev.body}
          </pre>
        </div>
      ))}
    </CollapsibleEventGroup>
  );
}

export function TodosBubble({ event }: { event: TodosEvent }) {
  const todos = event.todos ?? [];
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="text-sm">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        Working on ({done}/{todos.length})
      </div>
      <ul className="flex flex-col gap-1">
        {todos.map((t, i) => {
          const status = t.status ?? 'pending';
          const dot = status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○';
          const text =
            status === 'in_progress' && t.activeForm ? t.activeForm : (t.content ?? '(blank)');
          const cls =
            status === 'completed'
              ? 'text-muted-foreground line-through'
              : status === 'in_progress'
                ? 'text-foreground'
                : 'text-muted-foreground';
          return (
            <li key={i} className={`flex items-baseline gap-2 text-sm ${cls}`}>
              <span className="w-4 text-center text-xs">{dot}</span>
              <span className="break-words">{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function TaskStartBubble({ event }: { event: TaskStartEvent }) {
  return (
    <div className="border-l-2 border-accent pl-3 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent-foreground">
          {event.subagent || 'subagent'}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          delegated
        </span>
      </div>
      {event.description && (
        <div className="text-sm text-foreground">{event.description}</div>
      )}
    </div>
  );
}

export function TaskEndBubble({ event }: { event: TaskEndEvent }) {
  const text = event.result ?? '';
  return (
    <div className="group relative border-l-2 border-success pl-3 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-success px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-background">
          {event.subagent || 'subagent'}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          returned
        </span>
      </div>
      {text ? (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
        </div>
      ) : (
        <div className="text-sm italic text-muted-foreground">(no result text)</div>
      )}
    </div>
  );
}
