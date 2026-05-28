// Section 1.5.5 — Lightbox modal for `pc://attachment/<id>` rich-link clicks.
// Mounted at Shell. Reads attachment by id via the rich-link cache (so a hover
// preview won't re-fetch on click). Image-or-text body + download + "View
// parent" actions.

import { useEffect, useState } from 'react';

import type { ULID } from '@/features/projects/client';
import { workItemsApi, type Attachment } from '@/features/work-items/client';
import { useAttachmentLightbox } from '@/store/attachment-lightbox';
import { useChatWorkItemModal } from '@/store/chat-work-item-modal';

interface AttachmentLightboxMountProps {
  projectId: string;
}

export function AttachmentLightboxMount({ projectId }: AttachmentLightboxMountProps) {
  const attachmentId = useAttachmentLightbox((s) => s.attachmentId);
  const close = useAttachmentLightbox((s) => s.close);
  const openWorkItem = useChatWorkItemModal((s) => s.open);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!attachmentId) {
      setAttachment(null);
      setError(null);
      return;
    }
    let cancelled = false;
    workItemsApi.getAttachmentById(projectId as ULID, attachmentId as ULID)
      .then((a) => {
        if (!cancelled) setAttachment(a);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [attachmentId, projectId]);

  useEffect(() => {
    if (!attachmentId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachmentId, close]);

  if (!attachmentId) return null;

  const handleViewParent = () => {
    if (attachment) {
      openWorkItem(attachment.workItemId);
      close();
    }
  };
  const handleDownload = () => {
    if (!attachment) return;
    const blob = new Blob([attachment.content], {
      type: attachment.contentType ?? 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-background/80"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="flex max-h-[80vh] w-[min(720px,90vw)] flex-col border border-border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="truncate text-sm font-medium text-foreground">
            {attachment?.name ?? 'Attachment'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              onClick={handleViewParent}
              disabled={!attachment}
            >
              View parent
            </button>
            <button
              type="button"
              className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              onClick={handleDownload}
              disabled={!attachment}
            >
              Download
            </button>
            <button
              type="button"
              className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              onClick={close}
            >
              Close
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-4 py-3 text-xs">
          {error && <div className="text-destructive">{error}</div>}
          {!error && !attachment && (
            <div className="italic text-muted-foreground">Loading…</div>
          )}
          {attachment && <AttachmentBody attachment={attachment} />}
        </div>
      </div>
    </div>
  );
}

function AttachmentBody({ attachment }: { attachment: Attachment }) {
  const ct = attachment.contentType ?? 'text/plain';
  if (ct.startsWith('image/')) {
    // Attachments store content as string. If it looks like a data URI, use it;
    // otherwise fall back to base64 wrap.
    const src = attachment.content.startsWith('data:')
      ? attachment.content
      : `data:${ct};base64,${attachment.content}`;
    return (
      <img
        src={src}
        alt={attachment.name}
        className="max-h-[60vh] max-w-full border border-border"
      />
    );
  }
  // Text-ish — show as pre-formatted. JSON pretty-prints.
  let body = attachment.content;
  if (ct.includes('json')) {
    try {
      body = JSON.stringify(JSON.parse(attachment.content), null, 2);
    } catch {
      /* leave as-is */
    }
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground">
      {body}
    </pre>
  );
}
