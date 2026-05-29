import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import type { OrchestratorRuntimeHealth } from '@/features/runtime/client';
import type { ChatEvent, JsonlEvent, WsEnvelope, WsStatus } from '@/features/runtime/ws-types';

export const STALL_WARN_MS = 60_000;

export interface RuntimeInputCapabilities {
  canAcceptChatInput: boolean;
  canSubmitChatInput: boolean;
  canAcceptTerminalInput: boolean;
  canResizeTerminal: boolean;
  canInterrupt: boolean;
  stateLabel: string;
}

export type TransientRuntimeState = 'spawning' | 'ready' | 'thinking' | 'exited';

export interface OrchestratorInputCapabilityInput {
  composerHidden: boolean;
  composerDisabled: boolean;
  startingNewSession: boolean;
  wsStatus: WsStatus;
  runtimeHealth: OrchestratorRuntimeHealth | null;
  latestRuntimeState: string | null;
}

export function orchestratorInputCapabilities({
  composerHidden,
  composerDisabled,
  startingNewSession,
  wsStatus,
  runtimeHealth,
  latestRuntimeState,
}: OrchestratorInputCapabilityInput): RuntimeInputCapabilities {
  // The raw terminal is the recovery fallback. It must accept input whenever
  // the PTY child is alive, not only once the ready banner lands; otherwise an
  // unexpected provider boot/resume menu can block readiness and also block
  // the user's only way to dismiss the menu.
  return {
    canAcceptChatInput: !composerHidden && !composerDisabled,
    canSubmitChatInput: !composerHidden && !composerDisabled && !startingNewSession,
    canAcceptTerminalInput:
      !composerHidden &&
      !startingNewSession &&
      wsStatus === 'open' &&
      runtimeHealth !== null &&
      runtimeHealth !== 'not_spawned' &&
      runtimeHealth !== 'provider_missing' &&
      runtimeHealth !== 'failed_resume' &&
      runtimeHealth !== 'exited',
    canResizeTerminal:
      !composerHidden &&
      wsStatus === 'open' &&
      runtimeHealth !== 'not_spawned' &&
      runtimeHealth !== 'provider_missing' &&
      runtimeHealth !== 'failed_resume',
    canInterrupt:
      !composerHidden &&
      !startingNewSession &&
      wsStatus === 'open' &&
      runtimeHealth !== null &&
      runtimeHealth !== 'not_spawned' &&
      runtimeHealth !== 'provider_missing' &&
      runtimeHealth !== 'failed_resume',
    stateLabel: runtimeHealth ?? latestRuntimeState ?? wsStatus,
  };
}

export function transientInputCapabilities(
  state: TransientRuntimeState,
): RuntimeInputCapabilities {
  const ready = state === 'ready';
  const thinking = state === 'thinking';
  const active = ready || thinking;
  // Terminal stdin is the fallback escape hatch — keep it open for any live
  // PTY state (including 'spawning'), not only once the ready banner lands.
  // A new CC boot/resume menu we don't auto-press would otherwise stall the
  // session in 'spawning' with no way for the user to type past it. Only a
  // dead ('exited') child blocks input; writeRaw() no-ops there anyway.
  const alive = state !== 'exited';
  return {
    canAcceptChatInput: active,
    canSubmitChatInput: active,
    canAcceptTerminalInput: alive,
    canResizeTerminal: active,
    canInterrupt: active,
    stateLabel: state,
  };
}

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
