import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useChatScrollTarget } from '@/store/chat-scroll-target';

import type { RenderItem } from './types';

export function ChatTimeline({
  renderItems,
  autoFollowKey,
  resetKey,
  empty,
  terminalEligible,
  terminalActive,
  emptyState,
  thinkingIndicator,
  terminalPane,
  renderItem,
}: {
  renderItems: RenderItem[];
  autoFollowKey: number | string;
  resetKey: string | null;
  empty: boolean;
  terminalEligible: boolean;
  terminalActive: boolean;
  emptyState?: ReactNode;
  thinkingIndicator?: ReactNode;
  terminalPane?: ReactNode;
  renderItem: (item: RenderItem, index: number) => ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const handleChatScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setPinnedToBottom(distanceFromBottom < 50);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinnedToBottom(true);
  }, []);

  useEffect(() => {
    if (!pinnedToBottom) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoFollowKey, pinnedToBottom]);

  useEffect(() => {
    setPinnedToBottom(true);
  }, [resetKey]);

  const scrollTargetId = useChatScrollTarget((s) => s.targetId);
  const scrollTargetRequestedAt = useChatScrollTarget((s) => s.requestedAt);
  useEffect(() => {
    if (!scrollTargetId || !scrollTargetRequestedAt) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-bubble-id="${CSS.escape(scrollTargetId)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setPinnedToBottom(false);
    el.classList.add('ring-2', 'ring-warning', 'ring-offset-2', 'ring-offset-background');
    const timer = setTimeout(() => {
      el.classList.remove('ring-2', 'ring-warning', 'ring-offset-2', 'ring-offset-background');
    }, 1500);
    return () => clearTimeout(timer);
  }, [scrollTargetId, scrollTargetRequestedAt]);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollerRef}
        onScroll={handleChatScroll}
        className={
          'h-full overflow-y-auto px-4 py-3 ' +
          (terminalActive ? 'pointer-events-none invisible' : '')
        }
      >
        <div className="flex flex-col gap-3">
          {renderItems.map(renderItem)}
          {empty && emptyState && (
            <div className="text-center text-xs text-muted-foreground">{emptyState}</div>
          )}
          {thinkingIndicator}
        </div>
      </div>
      {!pinnedToBottom && (!terminalEligible || !terminalActive) && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 right-4 z-30 rounded-full px-3.5 py-1.5 text-xs font-bold opacity-100"
          style={{
            backgroundColor: '#f0d080',
            color: '#080604',
            border: '2px solid #080604',
            boxShadow: '0 0 0 1px #f5e8c8, 0 10px 30px rgba(0, 0, 0, 0.7)',
          }}
          title="Scroll to the latest messages"
        >
          ↓ Jump to present
        </button>
      )}
      {terminalPane}
    </div>
  );
}
