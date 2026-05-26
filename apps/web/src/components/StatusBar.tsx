// Bottom status footer for the chat panel.
//
// Section 32.4 reshape: model + token usage hoisted out to the App.tsx
// slim header (via useOrchestratorTelemetry). Footer keeps the operator
// bits: MCP status pill (clickable for the tool list), WS state, and the
// active project's workspace label. Slimmer height, quieter colours.

import { useEffect, useRef, useState } from 'react';

import { api } from '@/api/client';
import type { OrchestratorRuntimeHealth } from '@/api/client';
import type { WsStatus } from '@/hooks/use-project-ws';

// Re-export so other call sites still importing { UsageTotals } from this
// module compile. The canonical home is now @/store/orchestrator-telemetry.
export type { UsageTotals } from '@/store/orchestrator-telemetry';

interface McpStatus {
  alive: boolean;
  toolCount: number;
  tools: string[];
}

interface StatusBarProps {
  projectId: string | null;
  projectName: string | null;
  wsStatus: WsStatus;
  runtimeHealth?: OrchestratorRuntimeHealth | null;
}

const WS_PILL: Record<WsStatus, { dot: string; label: string; title: string }> = {
  open: { dot: 'bg-emerald-500', label: 'live', title: 'WebSocket connected' },
  connecting: { dot: 'bg-amber-500', label: '…', title: 'WebSocket connecting' },
  closed: { dot: 'bg-red-500', label: 'offline', title: 'WebSocket disconnected — retrying' },
  idle: { dot: 'bg-zinc-500', label: '—', title: 'No project selected' },
};

const RUNTIME_PILL: Record<OrchestratorRuntimeHealth, { dot: string; label: string; title: string }> = {
  not_spawned: {
    dot: 'bg-zinc-500',
    label: 'idle',
    title: 'Claude runtime has not spawned',
  },
  spawning: {
    dot: 'bg-amber-500',
    label: 'starting',
    title: 'Claude runtime is starting',
  },
  ready: {
    dot: 'bg-emerald-500',
    label: 'ready',
    title: 'Claude runtime is ready',
  },
  busy: {
    dot: 'bg-sky-500',
    label: 'busy',
    title: 'Claude runtime is processing a turn; new prompts will queue',
  },
  exited: {
    dot: 'bg-zinc-500',
    label: 'exited',
    title: 'Claude runtime exited; the durable session can resume on send',
  },
  respawning: {
    dot: 'bg-amber-500',
    label: 'restart',
    title: 'Claude runtime is restarting',
  },
  failed_resume: {
    dot: 'bg-red-500',
    label: 'failed',
    title: 'Claude runtime resume failed',
  },
  provider_missing: {
    dot: 'bg-red-500',
    label: 'missing',
    title: 'Claude provider transcript is unavailable',
  },
};

export function StatusBar({ projectId, wsStatus, runtimeHealth }: StatusBarProps) {
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [showMcp, setShowMcp] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const runtimePill = runtimeHealth ? RUNTIME_PILL[runtimeHealth] : null;

  useEffect(() => {
    if (!projectId) {
      setMcp({ alive: false, toolCount: 0, tools: [] });
      return;
    }
    let cancelled = false;
    async function tick() {
      try {
        const data = await api.getMcpStatus(projectId ?? undefined);
        if (!cancelled) setMcp(data);
      } catch {
        if (!cancelled) setMcp({ alive: false, toolCount: 0, tools: [] });
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId]);

  useEffect(() => {
    if (!showMcp) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (pillRef.current?.contains(target)) return;
      setShowMcp(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showMcp]);

  return (
    <div className="relative shrink-0 border-t border-border bg-card">
      <div className="flex items-center gap-3 px-3 py-1 text-[10px] uppercase tracking-[0.04em] text-muted-foreground">
        <button
          ref={pillRef}
          type="button"
          onClick={() => setShowMcp((s) => !s)}
          aria-expanded={showMcp}
          aria-label="MCP server status — click for details"
          className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted ${
            showMcp ? 'bg-muted text-foreground' : ''
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              mcp?.alive ? 'bg-emerald-500' : 'bg-zinc-500'
            }`}
            aria-hidden
          />
          <span className="text-foreground/50">mcp</span>
          <span className="tabular-nums text-foreground">
            {mcp === null
              ? '…'
              : mcp.alive
                ? `${mcp.toolCount} tools`
                : 'offline'}
          </span>
        </button>

        <span className="text-[var(--fg-dim)]">│</span>

        <span
          className="flex items-center gap-1.5"
          title={runtimePill?.title ?? 'Claude runtime status unavailable'}
          data-testid="runtime-pill"
          data-runtime-health={runtimeHealth ?? 'unknown'}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              runtimePill?.dot ?? 'bg-zinc-500'
            }`}
            aria-hidden
          />
          <span className="text-foreground/50">runtime</span>
          <span className="tabular-nums text-foreground">
            {runtimePill?.label ?? 'unknown'}
          </span>
        </span>

        <span className="text-[var(--fg-dim)]">│</span>

        <span
          className="flex items-center gap-1.5"
          title={WS_PILL[wsStatus].title}
          data-testid="ws-pill"
          data-ws-status={wsStatus}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${WS_PILL[wsStatus].dot}`}
            aria-hidden
          />
          <span className="text-foreground/50">ws</span>
          <span className="tabular-nums text-foreground">{WS_PILL[wsStatus].label}</span>
        </span>

        <span className="ml-auto text-[var(--fg-dim)]">caisson</span>
      </div>

      {showMcp && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="MCP server details"
          className="absolute bottom-full left-0 right-0 mb-1 max-h-72 overflow-y-auto border-t border-border bg-card px-3 py-2 text-xs shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  mcp?.alive ? 'bg-emerald-500' : 'bg-zinc-500'
                }`}
                aria-hidden
              />
              <span className="font-medium text-foreground">
                pc-rig {mcp?.alive ? '(connected)' : '(offline)'}
              </span>
              {mcp?.alive && (
                <span className="text-muted-foreground">
                  · {mcp.toolCount} {mcp.toolCount === 1 ? 'tool' : 'tools'}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowMcp(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close MCP details"
            >
              ✕
            </button>
          </div>

          {!mcp || mcp.tools.length === 0 ? (
            <p className="py-2 text-muted-foreground">
              {mcp === null
                ? 'Loading…'
                : !mcp.alive
                  ? 'No MCP servers reporting. The pc-rig server publishes a heartbeat to mcp-status.json; offline means no heartbeat in the last 8 seconds.'
                  : 'Server is alive but reports no tools.'}
            </p>
          ) : (
            <ul className="space-y-0.5 font-mono text-[11px] text-foreground/90">
              {mcp.tools.map((tool) => (
                <li key={tool} className="rounded px-1.5 py-0.5 hover:bg-muted">
                  {tool}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
