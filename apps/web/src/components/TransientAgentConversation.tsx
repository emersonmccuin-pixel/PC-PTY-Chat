import type { ReactNode } from 'react';

import type { OrchestratorSurfacePreference } from '@/api/client';
import { ChatSurface } from '@/components/ChatSurface';
import {
  ConversationHeader,
  ConversationHeaderButton,
} from '@/components/ConversationHeader';
import type { WsEnvelope } from '@/hooks/use-project-ws';

interface TransientAgentConversationProps {
  projectId: string;
  sessionId: string | null;
  events: WsEnvelope[];
  title: ReactNode;
  titleText?: string;
  subtitle?: ReactNode;
  statusLabel?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  onSend: (text: string) => boolean;
  onInterrupt: () => boolean;
  onTerminalInput: (data: string) => boolean;
  onTerminalResize: (cols: number, rows: number) => boolean;
  onAskReply?: (toolUseId: string, answer: string) => boolean;
  composerHistoryKey: string;
  composerDisabled?: boolean;
  terminalWritable?: boolean;
  composerPlaceholder?: string;
  emptyState?: ReactNode;
  onSurfaceModeChange?: (mode: OrchestratorSurfacePreference) => void;
}

export function TransientAgentConversation({
  projectId,
  sessionId,
  events,
  title,
  titleText,
  subtitle,
  statusLabel,
  onClose,
  closeLabel = 'Close',
  onSend,
  onInterrupt,
  onTerminalInput,
  onTerminalResize,
  onAskReply,
  composerHistoryKey,
  composerDisabled,
  terminalWritable,
  composerPlaceholder,
  emptyState,
  onSurfaceModeChange,
}: TransientAgentConversationProps) {
  const headerSlot = (
    <ConversationHeader
      title={title}
      titleText={titleText}
      subtitle={subtitle}
      status={statusLabel}
      actions={
        onClose ? (
          <ConversationHeaderButton onClick={onClose}>{closeLabel}</ConversationHeaderButton>
        ) : null
      }
    />
  );

  return (
    <ChatSurface
      events={events}
      projectId={projectId}
      currentSessionId={sessionId}
      onSend={onSend}
      onInterrupt={onInterrupt}
      onTerminalInput={onTerminalInput}
      onTerminalResize={onTerminalResize}
      onAskReply={onAskReply}
      composerHistoryKey={composerHistoryKey}
      defaultOrchestratorSurface="terminal"
      composerDisabled={composerDisabled}
      terminalWritable={terminalWritable}
      composerPlaceholder={composerPlaceholder}
      headerSlot={headerSlot}
      emptyState={emptyState}
      onSurfaceModeChange={onSurfaceModeChange}
    />
  );
}
