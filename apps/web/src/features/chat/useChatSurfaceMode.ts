import { useCallback, useEffect, useState } from 'react';

import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import {
  readTerminalMode,
  writeTerminalMode,
} from '@/features/chat/runtimeState';

export function useChatSurfaceMode({
  projectId,
  currentSessionId,
  terminalEligible,
  defaultOrchestratorSurface,
  onSurfaceModeChange,
}: {
  projectId: string;
  currentSessionId: string | null;
  terminalEligible: boolean;
  defaultOrchestratorSurface: OrchestratorSurfacePreference;
  onSurfaceModeChange?: (mode: OrchestratorSurfacePreference) => void;
}) {
  const [surfaceMode, setSurfaceMode] =
    useState<OrchestratorSurfacePreference>('chat');
  const [surfaceModeReady, setSurfaceModeReady] = useState(false);

  useEffect(() => {
    setSurfaceModeReady(false);
    if (!terminalEligible || !currentSessionId) {
      setSurfaceMode('chat');
      setSurfaceModeReady(true);
      return;
    }
    const stored = readTerminalMode(projectId, currentSessionId);
    setSurfaceMode(stored ?? defaultOrchestratorSurface);
    setSurfaceModeReady(true);
  }, [projectId, currentSessionId, terminalEligible, defaultOrchestratorSurface]);

  const terminalActive = terminalEligible && surfaceMode === 'terminal';

  useEffect(() => {
    if (!surfaceModeReady) return;
    onSurfaceModeChange?.(terminalActive ? 'terminal' : 'chat');
  }, [onSurfaceModeChange, surfaceModeReady, terminalActive]);

  const setTerminalMode = useCallback(
    (next: OrchestratorSurfacePreference) => {
      if (!terminalEligible || !currentSessionId) return;
      setSurfaceMode(next);
      writeTerminalMode(projectId, currentSessionId, next);
    },
    [projectId, currentSessionId, terminalEligible],
  );

  return {
    terminalActive,
    setTerminalMode,
  };
}
