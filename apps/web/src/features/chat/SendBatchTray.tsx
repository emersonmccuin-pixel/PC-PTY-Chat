import type { SendBatchChunk } from '@/features/chat/useSendBatch';

/**
 * Shows messages queued while Claude is busy (docs/chat-canonical-source-redesign.md
 * discussion). They send together as one prompt when Claude is ready. The last
 * chunk can be removed; the whole batch can be cleared.
 */
export function SendBatchTray({
  chunks,
  onCancelLast,
  onCancelAll,
}: {
  chunks: SendBatchChunk[];
  onCancelLast: () => void;
  onCancelAll: () => void;
}) {
  if (chunks.length === 0) return null;
  return (
    <div className="mx-2 mb-1 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs">
      <div className="mb-1 flex items-center justify-between text-muted-foreground">
        <span>
          {chunks.length} queued — sends together when Claude is ready
        </span>
        <button
          type="button"
          onClick={onCancelAll}
          className="hover:text-foreground"
          title="Discard all queued messages"
        >
          Cancel all
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {chunks.map((chunk, i) => (
          <li
            key={chunk.id}
            className="flex items-start gap-2 rounded bg-card/60 px-2 py-1"
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">
              {chunk.text}
            </span>
            {i === chunks.length - 1 && (
              <button
                type="button"
                onClick={onCancelLast}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title="Remove this queued message"
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
