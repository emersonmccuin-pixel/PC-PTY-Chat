import type { UserEvent, WsEnvelope } from '@/hooks/use-project-ws';

export interface ToolCall {
  toolUseId: string | null;
  tool: string;
  input: unknown;
  result: unknown;
  startedAt: string;
  ended: boolean;
  stableId: number;
  /** Most-recent `tool_progress` elapsed seconds for this tool execution. */
  progressElapsedSeconds: number | null;
  /** Most-recent `tool_progress` task_id, if any. */
  progressTaskId: string | null;
}

export interface ToolGroupItem {
  kind: 'tool-group';
  key: string;
  calls: ToolCall[];
}

export interface EnvItem {
  kind: 'env';
  key: string;
  env: WsEnvelope;
}

export interface EditItem {
  kind: 'edit';
  key: string;
  call: ToolCall;
}

export interface WorkflowEventEntry {
  kind: string;
  body: string;
}

export interface WorkflowRunGroupItem {
  kind: 'workflow-run-group';
  key: string;
  workflowRunId: string;
  events: WorkflowEventEntry[];
}

export interface AgentEventEntry {
  kind: string;
  body: string;
}

export interface AgentDispatchGroupItem {
  kind: 'agent-dispatch-group';
  key: string;
  agentRunId: string;
  agentName: string | null;
  events: AgentEventEntry[];
}

export type RenderItem =
  | ToolGroupItem
  | EnvItem
  | EditItem
  | WorkflowRunGroupItem
  | AgentDispatchGroupItem;

export interface StableEnvelope {
  origIdx: number;
  key?: string;
  env: WsEnvelope;
}

export type PendingPromptStatus =
  | 'sending'
  | 'server-received'
  | 'waiting-transcript'
  | 'unconfirmed'
  | 'failed';

export interface PendingPrompt {
  id: string;
  text: string;
  createdAt: number;
  eventFloor: number;
  status: PendingPromptStatus;
  expectsAck: boolean;
  queued: boolean;
  failureReason?: string;
}

export interface PendingUserEvent extends UserEvent {
  pendingStatus: PendingPromptStatus;
  pendingReason?: string;
  pendingClientMessageId: string;
  pendingQueued: boolean;
}
