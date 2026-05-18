import { asc, eq } from 'drizzle-orm';
import type { Attachment, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { attachments } from '../schema.ts';

interface AttachmentRow {
  id: ULID;
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType: string | null;
  runId: ULID | null;
  createdBySessionId: ULID | null;
  createdAt: number;
}

function toDomain(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    workItemId: row.workItemId,
    kind: row.kind,
    name: row.name,
    content: row.content,
    contentType: row.contentType,
    runId: row.runId,
    createdBySessionId: row.createdBySessionId,
    createdAt: row.createdAt,
  };
}

export interface CreateAttachmentInput {
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType?: string | null;
  runId?: ULID | null;
  createdBySessionId?: ULID | null;
}

export function createAttachment(input: CreateAttachmentInput): Attachment {
  const id = newId();
  const row: AttachmentRow = {
    id,
    workItemId: input.workItemId,
    kind: input.kind,
    name: input.name,
    content: input.content,
    contentType: input.contentType ?? null,
    runId: input.runId ?? null,
    createdBySessionId: input.createdBySessionId ?? null,
    createdAt: Date.now(),
  };
  getDb().insert(attachments).values(row).run();
  return toDomain(row);
}

export function listAttachmentsForWorkItem(workItemId: ULID): Attachment[] {
  const rows = getDb()
    .select()
    .from(attachments)
    .where(eq(attachments.workItemId, workItemId))
    .orderBy(asc(attachments.createdAt))
    .all() as AttachmentRow[];
  return rows.map(toDomain);
}

export function getAttachment(id: ULID): Attachment | null {
  const row = getDb()
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .get() as AttachmentRow | undefined;
  return row ? toDomain(row) : null;
}

/** Hard-delete. Attachments don't soft-delete (no restore UX in scope). */
export function deleteAttachment(id: ULID): boolean {
  const result = getDb().delete(attachments).where(eq(attachments.id, id)).run();
  return (result.changes ?? 0) > 0;
}
