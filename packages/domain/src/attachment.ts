// Attachment domain type. Files (or text payloads) produced by workflows or
// the chat orchestrator and bound to a work item. Content lives INLINE in the
// DB — there is no filesystem-path variant.

import type { ULID } from './ulid.ts';

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
  createdAt: number;
}
