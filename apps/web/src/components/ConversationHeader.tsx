import type { ReactNode } from 'react';

interface ConversationHeaderProps {
  title: ReactNode;
  titleText?: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}

export function ConversationHeader({
  title,
  titleText,
  subtitle,
  status,
  actions,
}: ConversationHeaderProps) {
  return (
    <div
      data-testid="conversation-header"
      className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2"
    >
      <div className="min-w-0 flex-1 truncate text-sm" title={titleText}>
        {title}
        {subtitle && (
          <span className="ml-2 text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {status && <span className="shrink-0 text-xs text-muted-foreground">{status}</span>}
      {actions}
    </div>
  );
}

export function ConversationHeaderButton({
  children,
  disabled,
  onClick,
  title,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-60"
      title={title}
    >
      {children}
    </button>
  );
}
