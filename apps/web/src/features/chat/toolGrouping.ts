import type {
  ChatEvent,
  ToolEndEvent,
  ToolStartEvent,
  UserEvent,
  WsEnvelope,
} from '@/hooks/use-project-ws';
import { parseUserText } from '@/lib/parse-chat-text';

import type {
  AgentDispatchGroupItem,
  RenderItem,
  StableEnvelope,
  ToolCall,
  WorkflowRunGroupItem,
} from './types';

const SUPPRESSED_TOOLS = new Set([
  'Agent',
  'Task',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
  'ToolSearch',
]);

const HIGHLIGHT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

export function synthesizeRenderItems(entries: StableEnvelope[]): RenderItem[] {
  const items: RenderItem[] = [];
  let buffer: ToolCall[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      items.push({ kind: 'tool-group', key: `tg-${buffer[0]!.stableId}`, calls: buffer });
      buffer = [];
    }
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const env = entry.env;
    const stableId = entry.origIdx;
    const stableKey = entry.key ?? `${stableId}`;
    if (env.type === 'ask') {
      flush();
      items.push({ kind: 'env', key: `env-${stableKey}`, env });
      continue;
    }
    if (env.type !== 'event') {
      flush();
      items.push({ kind: 'env', key: `env-${stableKey}`, env });
      continue;
    }
    const ev = (env as WsEnvelope & { event: ChatEvent }).event;
    if (!ev || typeof ev !== 'object' || !('kind' in ev)) {
      flush();
      items.push({ kind: 'env', key: `env-${stableKey}`, env });
      continue;
    }
    if (
      (ev.kind === 'tool-start' || ev.kind === 'tool-end') &&
      SUPPRESSED_TOOLS.has((ev as ToolStartEvent | ToolEndEvent).tool)
    ) {
      continue;
    }
    if (ev.kind === 'tool-start') {
      const t = ev as ToolStartEvent;
      const call: ToolCall = {
        toolUseId: t.toolUseId ?? null,
        tool: t.tool,
        input: t.input ?? null,
        result: null,
        startedAt: t.ts ?? `${stableId}`,
        ended: false,
        stableId,
        progressElapsedSeconds: null,
        progressTaskId: null,
      };
      if (HIGHLIGHT_TOOLS.has(t.tool)) {
        flush();
        items.push({ kind: 'edit', key: `edit-${stableId}`, call });
      } else {
        buffer.push(call);
      }
      continue;
    }
    if (ev.kind === 'tool-progress') {
      const tp = ev as {
        toolUseId: string;
        elapsedSeconds: number | null;
        taskId: string | null;
      };
      const apply = (c: ToolCall) => {
        c.progressElapsedSeconds = tp.elapsedSeconds;
        c.progressTaskId = tp.taskId;
      };
      let matched = false;
      for (const c of buffer) {
        if (!c.ended && c.toolUseId === tp.toolUseId) {
          apply(c);
          matched = true;
          break;
        }
      }
      if (!matched) {
        for (let j = items.length - 1; j >= 0; j--) {
          const it = items[j]!;
          if (it.kind === 'edit') {
            if (!it.call.ended && it.call.toolUseId === tp.toolUseId) {
              apply(it.call);
              matched = true;
              break;
            }
          } else if (it.kind === 'tool-group') {
            for (let k = it.calls.length - 1; k >= 0; k--) {
              const c = it.calls[k]!;
              if (!c.ended && c.toolUseId === tp.toolUseId) {
                apply(c);
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
        }
      }
      continue;
    }
    if (ev.kind === 'tool-end') {
      const t = ev as ToolEndEvent;
      let matched: ToolCall | null = null;
      for (let j = items.length - 1; j >= 0; j--) {
        const it = items[j]!;
        if (it.kind !== 'edit') continue;
        const c = it.call;
        if (c.ended) continue;
        if (t.toolUseId && c.toolUseId === t.toolUseId) {
          matched = c;
          break;
        }
        if (!t.toolUseId && c.tool === t.tool) {
          matched = c;
          break;
        }
      }
      if (!matched && t.toolUseId) {
        for (const c of buffer) {
          if (c.toolUseId === t.toolUseId && !c.ended) {
            matched = c;
            break;
          }
        }
      }
      if (!matched) {
        for (let j = buffer.length - 1; j >= 0; j--) {
          const c = buffer[j]!;
          if (!c.ended && c.tool === t.tool) {
            matched = c;
            break;
          }
        }
      }
      if (!matched) {
        for (let j = items.length - 1; j >= 0; j--) {
          const it = items[j]!;
          if (it.kind === 'edit') continue;
          if (it.kind !== 'tool-group') break;
          for (let k = it.calls.length - 1; k >= 0; k--) {
            const c = it.calls[k]!;
            if (!c.ended && (t.toolUseId ? c.toolUseId === t.toolUseId : c.tool === t.tool)) {
              matched = c;
              break;
            }
          }
          if (matched) break;
        }
      }
      if (matched) {
        matched.result = t.result ?? null;
        matched.ended = true;
      } else {
        buffer.push({
          toolUseId: t.toolUseId ?? null,
          tool: t.tool,
          input: null,
          result: t.result ?? null,
          startedAt: t.ts ?? `${stableId}`,
          ended: true,
          stableId,
          progressElapsedSeconds: null,
          progressTaskId: null,
        });
      }
      continue;
    }
    if (ev.kind === 'user') {
      const userText = (ev as UserEvent).text ?? '';
      const parts = parseUserText(userText);
      let hoistedAny = false;
      let hasVisible = false;
      for (const part of parts) {
        if (part.kind === 'workflow-event' && part.workflowRunId) {
          flush();
          const id = part.workflowRunId;
          let group: WorkflowRunGroupItem | null = null;
          for (let j = items.length - 1; j >= 0; j--) {
            const it = items[j]!;
            if (it.kind === 'workflow-run-group' && it.workflowRunId === id) {
              group = it;
              break;
            }
          }
          if (!group) {
            group = {
              kind: 'workflow-run-group',
              key: `wfg-${id}`,
              workflowRunId: id,
              events: [],
            };
            items.push(group);
          }
          group.events.push({
            kind: part.workflowEventKind ?? 'unknown',
            body: part.text,
          });
          hoistedAny = true;
        } else if (part.kind === 'agent-event' && part.agentRunId) {
          flush();
          const id = part.agentRunId;
          let group: AgentDispatchGroupItem | null = null;
          for (let j = items.length - 1; j >= 0; j--) {
            const it = items[j]!;
            if (it.kind === 'agent-dispatch-group' && it.agentRunId === id) {
              group = it;
              break;
            }
          }
          if (!group) {
            group = {
              kind: 'agent-dispatch-group',
              key: `adg-${id}`,
              agentRunId: id,
              agentName: part.agentName ?? null,
              events: [],
            };
            items.push(group);
          } else if (!group.agentName && part.agentName) {
            group.agentName = part.agentName;
          }
          group.events.push({
            kind: part.agentEventKind ?? 'unknown',
            body: part.text,
          });
          hoistedAny = true;
        } else {
          hasVisible = true;
        }
      }
      if (hoistedAny && !hasVisible) {
        continue;
      }
    }
    flush();
    items.push({ kind: 'env', key: `env-${stableKey}`, env });
  }
  flush();
  return items;
}
