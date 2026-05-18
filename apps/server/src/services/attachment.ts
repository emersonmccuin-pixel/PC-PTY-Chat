// AttachmentService — project-scoped facade over the attachments repo.
//
// Asserts the target work item belongs to this project before exposing any
// CRUD path. The 2b spec only exposes list/get/delete to the UI; create is
// reserved for workflows (separate internal route, not wired in this phase).
// We still expose `create` here so the workflow-runtime + MCP tool can call
// through one consistent code path.

import type { Attachment, AttachmentSource, ULID, WorkItem } from '@pc/domain';
import {
  createAttachment as dbCreateAttachment,
  deleteAttachment as dbDeleteAttachment,
  getAttachment as dbGetAttachment,
  listAttachmentsForWorkItem,
} from '@pc/db';

export type AttachmentBroadcast = (event: {
  type: 'attachment-changed';
  change: 'created' | 'deleted';
  workItemId: ULID;
  attachment: Attachment;
}) => void;

export interface AttachmentServiceOptions {
  projectId: ULID;
  /** Read a work item by id — used to verify project ownership before any
   *  attachment CRUD. Returns null for unknown / archived rows. */
  getWorkItem: (id: ULID) => WorkItem | null;
  broadcast: AttachmentBroadcast;
}

export interface CreateAttachmentServiceInput {
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType?: string | null;
  runId?: ULID | null;
  createdBySessionId?: ULID | null;
  /** Provenance — who produced this attachment. Defaults to 'user'. The MCP
   *  `pc_attach_to_work_item` tool passes 'agent'. */
  source?: AttachmentSource;
  /** When `source === 'agent'`, the agent name. */
  agentName?: string | null;
  /** Workflow node id within `runId`. Null for non-workflow paths. */
  nodeId?: string | null;
}

/** Attachment not in this project's work-item tree. Maps to HTTP 404. */
export class AttachmentNotInProjectError extends Error {
  constructor(public readonly id: ULID) {
    super(`attachment ${id} not in this project`);
    this.name = 'AttachmentNotInProjectError';
  }
}

export class AttachmentService {
  constructor(private readonly opts: AttachmentServiceOptions) {}

  list(workItemId: ULID): Attachment[] {
    this.assertWorkItemInProject(workItemId);
    return listAttachmentsForWorkItem(workItemId);
  }

  get(id: ULID): Attachment {
    const attachment = dbGetAttachment(id);
    if (!attachment) throw new AttachmentNotInProjectError(id);
    this.assertWorkItemInProject(attachment.workItemId);
    return attachment;
  }

  delete(id: ULID): void {
    const attachment = dbGetAttachment(id);
    if (!attachment) throw new AttachmentNotInProjectError(id);
    this.assertWorkItemInProject(attachment.workItemId);
    dbDeleteAttachment(id);
    this.opts.broadcast({
      type: 'attachment-changed',
      change: 'deleted',
      workItemId: attachment.workItemId,
      attachment,
    });
  }

  create(input: CreateAttachmentServiceInput): Attachment {
    this.assertWorkItemInProject(input.workItemId);
    const attachment = dbCreateAttachment(input);
    this.opts.broadcast({
      type: 'attachment-changed',
      change: 'created',
      workItemId: attachment.workItemId,
      attachment,
    });
    return attachment;
  }

  private assertWorkItemInProject(workItemId: ULID): void {
    const wi = this.opts.getWorkItem(workItemId);
    if (!wi || wi.projectId !== this.opts.projectId) {
      throw new AttachmentNotInProjectError(workItemId);
    }
  }
}
