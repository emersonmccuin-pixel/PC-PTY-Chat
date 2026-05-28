import { useMemo } from 'react';

import type { WsEnvelope } from '@/hooks/use-project-ws';

import {
  deriveJsonlBusy,
  deriveLiveState,
  isRuntimeThinking,
} from './runtimeState';
import { useThinkingIndicatorState } from './useThinkingIndicatorState';

export function useChatRuntimeThinking(events: WsEnvelope[]) {
  const liveState = useMemo(() => deriveLiveState(events), [events]);
  const jsonlBusy = useMemo(() => deriveJsonlBusy(events), [events]);
  const isThinking = isRuntimeThinking(liveState, jsonlBusy);
  const indicatorState = useThinkingIndicatorState({ events, isThinking });

  return {
    isThinking,
    ...indicatorState,
  };
}
