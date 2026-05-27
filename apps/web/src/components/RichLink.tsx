// Inline pill for pc:// references (work-item / file / attachment / inbox).
// Visual spec: the rich-link visual spec.
//
// 1.5.2 ships the primitive + click handler routing. Hover preview (1.5.4)
// and broken-state (1.5.8) bolt on later via the broken/onHover props.

import type { MouseEvent, ReactNode } from 'react';

import type { RichLinkKind } from '@/lib/parse-chat-text';

export interface RichLinkProps {
  kind: RichLinkKind;
  /** id for work-item/attachment/inbox; workspace-relative posix path for file. */
  ref: string;
  /** visible link text. */
  text: string;
  /** full pc:// URL (cache key for 1.5.3). */
  url: string;
  /** when true, render struck-through + non-interactive. Set by 1.5.8 after a
   *  fetch confirms the entity is gone. */
  broken?: boolean;
  /** click handler — opens the per-kind modal/tab in 1.5.6. */
  onActivate?: (kind: RichLinkKind, ref: string, url: string) => void;
  /** hover handlers used by 1.5.4 to anchor the preview card. */
  onHoverStart?: (anchor: HTMLSpanElement, url: string) => void;
  onHoverEnd?: () => void;
  /** Optional content override (e.g. custom glyph + label). Defaults to text. */
  children?: ReactNode;
}

export function RichLink({
  kind,
  ref: entityRef,
  text,
  url,
  broken,
  onActivate,
  onHoverStart,
  onHoverEnd,
  children,
}: RichLinkProps) {
  const handleClick = (e: MouseEvent<HTMLSpanElement>) => {
    if (broken) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate?.(kind, entityRef, url);
  };
  const handleEnter = (e: MouseEvent<HTMLSpanElement>) => {
    if (broken) return;
    onHoverStart?.(e.currentTarget, url);
  };
  const handleLeave = () => {
    if (broken) return;
    onHoverEnd?.();
  };
  const title = broken ? 'Reference no longer available' : undefined;
  return (
    <span
      role={broken ? undefined : 'button'}
      tabIndex={broken ? undefined : 0}
      className="pc-rich-link"
      data-kind={kind}
      data-ref={entityRef}
      data-url={url}
      data-broken={broken ? 'true' : undefined}
      title={title}
      onClick={handleClick}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onKeyDown={(e) => {
        if (broken) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate?.(kind, entityRef, url);
        }
      }}
    >
      {children ?? text}
    </span>
  );
}
