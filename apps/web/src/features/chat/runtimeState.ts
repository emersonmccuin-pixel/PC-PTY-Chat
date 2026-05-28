import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import type { ChatEvent, JsonlEvent, WsEnvelope } from '@/hooks/use-project-ws';

export const STALL_WARN_MS = 60_000;

export function terminalModeStorageKey(projectId: string, sessionId: string): string {
  return `pc.terminal-mode.${projectId}.${sessionId}`;
}

export function readTerminalMode(
  projectId: string,
  sessionId: string,
): OrchestratorSurfacePreference | null {
  try {
    const value = localStorage.getItem(terminalModeStorageKey(projectId, sessionId));
    return value === 'chat' || value === 'terminal' ? value : null;
  } catch {
    return null;
  }
}

export function writeTerminalMode(
  projectId: string,
  sessionId: string,
  value: OrchestratorSurfacePreference,
): void {
  try {
    localStorage.setItem(terminalModeStorageKey(projectId, sessionId), value);
  } catch {
    /* storage disabled */
  }
}

export function deriveLiveState(events: WsEnvelope[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const env = events[i]!;
    if (env.type === 'turn-end') return 'ready';
    if (env.type === 'state') return (env as WsEnvelope & { state: string }).state;
    if (env.type === 'event') {
      const ev = (env as WsEnvelope & { event: ChatEvent }).event;
      if (ev?.kind === 'stop-failure') return 'ready';
    }
  }
  return null;
}

export function deriveJsonlBusy(events: WsEnvelope[]): boolean | null {
  let anyJsonl = false;
  let busy = false;
  for (const env of events) {
    if (env.type !== 'jsonl') continue;
    const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
    if (!ev || typeof ev !== 'object') continue;
    anyJsonl = true;
    if (ev.kind === 'jsonl-user') busy = true;
    else if (ev.kind === 'jsonl-turn-end') busy = false;
  }
  return anyJsonl ? busy : null;
}

export function isRuntimeThinking(
  liveState: string | null,
  jsonlBusy: boolean | null,
): boolean {
  return jsonlBusy === null
    ? liveState === 'thinking' || liveState === 'busy'
    : jsonlBusy &&
        liveState !== 'ready' &&
        liveState !== 'exited' &&
        liveState !== 'spawning';
}

export function deriveActivity(events: WsEnvelope[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const env = events[i]!;
    if (env.type !== 'jsonl') continue;
    const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
    if (!ev) continue;
    if (ev.kind === 'jsonl-turn-end') return null;
    if (ev.kind === 'jsonl-tool-call') return activityLabel(ev.name, ev.input);
    if (ev.kind === 'jsonl-tool-result') return 'Working through the result';
    if (ev.kind === 'jsonl-stream-event') return 'Writing a response';
  }
  return null;
}

const TOOL_VERBS: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
  Bash: 'Running',
  PowerShell: 'Running',
  Glob: 'Finding files',
  Grep: 'Searching',
  WebFetch: 'Fetching',
  WebSearch: 'Searching the web',
  Task: 'Delegating to',
  Agent: 'Delegating to',
  TodoWrite: 'Updating the plan',
};

export function activityLabel(tool: string, input: unknown): string {
  const clean = tool.startsWith('mcp__')
    ? tool.split('__').pop() ?? tool
    : tool;
  const verb = TOOL_VERBS[tool];
  const base = verb ?? clean;
  const summary = summarizeInput(tool, input);
  return summary ? `${base} ${summary}` : base;
}

export function summarizeInput(tool: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return typeof i.file_path === 'string'
        ? i.file_path
        : typeof i.notebook_path === 'string'
          ? i.notebook_path
          : '';
    case 'Bash':
    case 'PowerShell': {
      const cmd = typeof i.command === 'string' ? i.command : '';
      const first = cmd.split('\n')[0] ?? '';
      return first.length > 80 ? first.slice(0, 80) + '\u2026' : first;
    }
    case 'Glob':
      return typeof i.pattern === 'string' ? i.pattern : '';
    case 'Grep': {
      const p = typeof i.pattern === 'string' ? i.pattern : '';
      const g = typeof i.glob === 'string' ? ` · ${i.glob}` : '';
      return p + g;
    }
    case 'WebFetch':
      return typeof i.url === 'string' ? i.url : '';
    case 'WebSearch':
      return typeof i.query === 'string' ? i.query : '';
    default:
      return '';
  }
}
