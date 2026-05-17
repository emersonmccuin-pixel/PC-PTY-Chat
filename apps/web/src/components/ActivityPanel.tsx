// Q12 — full WS event log + all-projects toggle.
//
// Consumes events from props (App.tsx picks the source based on
// showAllProjects: useProjectWs for active mode, useAllProjectsWs for the
// rest of the rail). The panel is presentational — it doesn't own a hook
// itself.
//
// Raw PTY byte-stream events ('raw') are filtered out as noise. Everything
// else gets a row with timestamp, optional project slug pill, event kind,
// and a short summary derived from the envelope.

import { useMemo } from 'react';

import type { Project } from '@/api/client';
import type { WsEnvelope, WsStatus } from '@/hooks/use-project-ws';

interface ActivityPanelProps {
  projects: Project[];
  events: WsEnvelope[];
  status: WsStatus;
  showAllProjects: boolean;
  onToggleShowAll: (next: boolean) => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<WsStatus, string> = {
  idle: 'idle',
  connecting: 'connecting…',
  open: 'live',
  closed: 'disconnected',
};

const STATUS_COLOR: Record<WsStatus, string> = {
  idle: 'text-muted-foreground',
  connecting: 'text-warning',
  open: 'text-success',
  closed: 'text-destructive',
};

export function ActivityPanel({
  projects,
  events,
  status,
  showAllProjects,
  onToggleShowAll,
  onClose,
}: ActivityPanelProps) {
  const slugById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.slug);
    return m;
  }, [projects]);

  // Newest-first, raw/state stream filtered out.
  const rows = useMemo(() => {
    const filtered: WsEnvelope[] = [];
    for (const env of events) {
      if (env.type === 'raw' || env.type === 'state') continue;
      filtered.push(env);
    }
    return filtered.slice(-200).reverse();
  }, [events]);

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          Activity
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onToggleShowAll(!showAllProjects)}
            title={showAllProjects ? 'Show active project only' : 'Show all projects'}
            className={
              'px-1.5 py-0.5 text-[10px] uppercase tracking-wider ' +
              (showAllProjects
                ? 'bg-primary/20 text-primary hover:bg-primary/30'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground')
            }
          >
            All
          </button>
          <button
            onClick={onClose}
            title="Hide activity panel"
            aria-label="Hide activity panel"
            className="px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            ▸
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs">
        <span className={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</span>
        <span className="text-muted-foreground">{rows.length} events</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {status === 'idle'
              ? showAllProjects
                ? 'No projects.'
                : 'No project selected.'
              : 'Waiting for events…'}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((env, i) => (
              <li
                key={`${env.type}-${rows.length - i}`}
                className="px-3 py-1.5"
              >
                <EventRow env={env} slug={slugById.get(env.projectId) ?? '?'} showSlug={showAllProjects} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EventRow({
  env,
  slug,
  showSlug,
}: {
  env: WsEnvelope;
  slug: string;
  showSlug: boolean;
}) {
  const { kind, summary, color } = describeEnvelope(env);
  const ts = extractTs(env);
  const hoverText = summary
    ? `[${ts}${showSlug ? ' ' + slug : ''}] ${kind}: ${summary}`
    : `[${ts}${showSlug ? ' ' + slug : ''}] ${kind}`;
  return (
    <div className="flex items-baseline gap-2 text-[11px]" title={hoverText}>
      <span className="shrink-0 font-mono text-muted-foreground">{ts}</span>
      {showSlug && (
        <span className="shrink-0 bg-muted px-1 font-mono text-[10px] uppercase tracking-wider text-foreground">
          {slug}
        </span>
      )}
      <span className={`shrink-0 font-mono text-[10px] uppercase tracking-wider ${color}`}>
        {kind}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground/80">{summary}</span>
    </div>
  );
}

function describeEnvelope(env: WsEnvelope): { kind: string; summary: string; color: string } {
  switch (env.type) {
    case 'event': {
      const event = (env.event ?? {}) as Record<string, unknown>;
      const kind = String(event.kind ?? 'event');
      const summary = summarizeChatEvent(kind, event);
      return { kind, summary, color: chatEventColor(kind) };
    }
    case 'work-items-changed': {
      const change = String(env.change ?? '');
      const wi = (env.workItem ?? {}) as Record<string, unknown>;
      const title = typeof wi.title === 'string' ? wi.title : String(wi.id ?? '');
      return {
        kind: 'work-item',
        summary: `${change}: ${title}`,
        color: 'text-foreground/60',
      };
    }
    case 'channel-event': {
      const event = (env.event ?? {}) as Record<string, unknown>;
      const source = typeof event.source === 'string' ? event.source : '?';
      const body =
        typeof event.body === 'string'
          ? event.body
          : event.body != null
            ? JSON.stringify(event.body)
            : '';
      return {
        kind: 'channel',
        summary: `${source}: ${body}`,
        color: 'text-primary',
      };
    }
    case 'ask': {
      return {
        kind: 'ask',
        summary: `${env.toolName ?? '?'} (${env.toolUseId ?? '?'})`,
        color: 'text-warning',
      };
    }
    case 'turn-end':
      return { kind: 'turn-end', summary: '', color: 'text-muted-foreground' };
    case 'exit':
      return {
        kind: 'exit',
        summary: `code=${env.code ?? '?'} signal=${env.signal ?? '?'}`,
        color: 'text-destructive',
      };
    default:
      return { kind: env.type, summary: '', color: 'text-muted-foreground' };
  }
}

function summarizeChatEvent(kind: string, event: Record<string, unknown>): string {
  const text = (k: string): string => (typeof event[k] === 'string' ? (event[k] as string) : '');
  switch (kind) {
    case 'user':
    case 'assistant':
      return text('text');
    case 'tool-start':
    case 'tool-end':
      return text('tool');
    case 'todos': {
      const todos = Array.isArray(event.todos) ? (event.todos as unknown[]) : [];
      return `${todos.length} todo(s)`;
    }
    case 'task-start':
    case 'task-end':
      return `${text('subagent')}${text('description') ? `: ${text('description')}` : ''}`;
    case 'approval-required':
      return text('message') || text('nodeId');
    default:
      return '';
  }
}

function chatEventColor(kind: string): string {
  switch (kind) {
    case 'user':
      return 'text-primary';
    case 'assistant':
      return 'text-foreground';
    case 'tool-start':
    case 'tool-end':
      return 'text-muted-foreground';
    case 'task-start':
    case 'task-end':
      return 'text-success';
    case 'approval-required':
      return 'text-warning';
    case 'todos':
      return 'text-foreground/60';
    default:
      return 'text-muted-foreground';
  }
}

function extractTs(env: WsEnvelope): string {
  // event-capture.cjs sets `ts: new Date().toISOString()` on the inner event.
  const inner = (env.event as Record<string, unknown> | undefined) ?? {};
  const raw = typeof inner.ts === 'string' ? inner.ts : null;
  if (!raw) return '--:--:--';
  // ISO → HH:MM:SS.
  const m = raw.match(/T(\d\d:\d\d:\d\d)/);
  return m ? m[1]! : raw;
}
