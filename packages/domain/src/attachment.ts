// Attachment domain type. Files (or text payloads) produced by workflows or
// the chat orchestrator and bound to a work item. Content lives INLINE in the
// DB — there is no filesystem-path variant.

import type { ULID } from './ulid.ts';

/** Who produced this attachment. `agent` = workflow subagent (via the MCP
 *  `pc_attach_to_work_item` tool). `user` = anything else (chat, UI). The
 *  source distinguishes agent-generated artifacts so Human Review can surface
 *  them and Section 7 can render an "agent" badge. */
export type AttachmentSource = 'agent' | 'user';

export interface Attachment {
  id: ULID;
  workItemId: ULID;
  /** Free-form kind tag. Known: 'text' | 'markdown' | 'json'. Other strings allowed. */
  kind: string;
  name: string;
  /** Inline payload. Future binary support stores base64 here with contentType set. */
  content: string;
  contentType: string | null;
  /** Workflow run that produced this attachment, or null for chat/user-created. */
  runId: ULID | null;
  createdBySessionId: ULID | null;
  /** Provenance: who produced this attachment. Defaults to 'user' for existing
   *  rows (pre-3e.2). Set to 'agent' when created via MCP from a subagent. */
  source: AttachmentSource;
  /** When `source === 'agent'`: the agent name that produced this. */
  agentName: string | null;
  /** When the attachment came from a workflow node: the node id within `runId`. */
  nodeId: string | null;
  createdAt: number;
}
