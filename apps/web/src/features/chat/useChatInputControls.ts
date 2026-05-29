import { useCallback } from 'react';

import type { RuntimeInputCapabilities } from '@/features/chat/runtimeState';
import type { WsStatus } from '@/features/runtime/ws-types';

export function useChatInputControls({
  inputCapabilities,
  composerDisabled,
  composerSendDisabled,
  terminalActive,
  wsStatus,
  onTerminalResize,
}: {
  inputCapabilities?: RuntimeInputCapabilities;
  composerDisabled?: boolean;
  composerSendDisabled?: boolean;
  terminalActive: boolean;
  wsStatus?: WsStatus;
  onTerminalResize?: (cols: number, rows: number) => boolean;
}) {
  const resolvedComposerDisabled = inputCapabilities
    ? !inputCapabilities.canAcceptChatInput
    : composerDisabled;
  const resolvedComposerSendDisabled = inputCapabilities
    ? !inputCapabilities.canSubmitChatInput
    : composerSendDisabled;
  const resolvedInterruptDisabled = inputCapabilities
    ? !inputCapabilities.canInterrupt
    : false;
  const resolvedTerminalWritable =
    terminalActive &&
    (inputCapabilities?.canAcceptTerminalInput ??
      (!resolvedComposerDisabled &&
        !resolvedComposerSendDisabled &&
        (wsStatus === undefined || wsStatus === 'open')));

  const handleTerminalResize = useCallback(
    (cols: number, rows: number): boolean => {
      if (inputCapabilities && !inputCapabilities.canResizeTerminal) return false;
      return onTerminalResize?.(cols, rows) ?? false;
    },
    [inputCapabilities, onTerminalResize],
  );

  return {
    resolvedComposerDisabled,
    resolvedComposerSendDisabled,
    resolvedInterruptDisabled,
    resolvedTerminalWritable,
    handleTerminalResize,
  };
}
