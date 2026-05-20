// Bottom status bar for the chat panel (chat.md Phase 2 #9–10).
//
// Surfaces: active model · session token usage + est. API cost · MCP status
// pill. Clicking the MCP pill expands a detail panel listing the alive server
// + its tools, populated from `/api/mcp-status` (polled every 5s while
// mounted).
//
// Cost is labeled "est." — user is on subscription billing, so the dollar
// figure is informational/diagnostic only. Pricing constants are Opus list
// rates; subagents pick their own model and don't feed orchestrator totals
// (sidechain short-circuits in the JSONL tailer).

import { useEffect, useRef, useState } from 'react';

import { api } from '@/api/client';
import type { WsStatus } from '@/hooks/use-project-ws';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

interface McpStatus {
  alive: boolean;
  toolCount: number;
  tools: string[];
}

interface StatusBarProps {
  model: string | null;
  usage: UsageTotals;
  projectId: string | null;
  wsStatus: WsStatus;
}

// Anthropic list pricing per 1M tokens (Opus tier).
const OPUS_PRICING_PER_TOKEN = {
  input: 15 / 1_000_000,
  output: 75 / 1_000_000,
  cacheCreate: 18.75 / 1_000_000,
  cacheRead: 1.5 / 1_000_000,
};

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

function formatCost(dollars: number): string {
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return '<$0.01';
  if (dollars < 1) return '$' + dollars.toFixed(3);
  return '$' + dollars.toFixed(2);
}

function totalCost(u: UsageTotals): number {
  return (
    u.inputTokens * OPUS_PRICING_PER_TOKEN.input +
    u.outputTokens * OPUS_PRICING_PER_TOKEN.output +
    u.cacheCreationTokens * OPUS_PRICING_PER_TOKEN.cacheCreate +
    u.cacheReadTokens * OPUS_PRICING_PER_TOKEN.cacheRead
  );
}

const WS_PILL: Record<WsStatus, { dot: string; label: string; title: string }> = {
  open: { dot: 'bg-emerald-500', label: 'live', title: 'WebSocket connected' },
  connecting: { dot: 'bg-amber-500', label: '…', title: 'WebSocket connecting' },
  closed: { dot: 'bg-red-500', label: 'offline', title: 'WebSocket disconnected — retrying' },
  idle: { dot: 'bg-zinc-500', label: '—', title: 'No project selected' },
};

export function StatusBar({ model, usage, projectId, wsStatus }: StatusBarProps) {
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [showMcp, setShowMcp] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);

  // Poll /api/mcp-status every 5s while mounted. 8s liveness window on the
  // server means we miss at most one tick before the pill goes dark. The
  // heartbeat is per-project (writer keys on PC_PROJECT_ID), so we pass the
  // active projectId; without one the endpoint falls back to the legacy
  // global path which nothing writes today.
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

  // Click-outside closes the panel.
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

  const totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationTokens +
    usage.cacheReadTokens;
  const cost = totalCost(usage);
  const hasUsage = totalTokens > 0;

  const usageTitle =
    `input:        ${usage.inputTokens.toLocaleString()}\n` +
    `output:       ${usage.outputTokens.toLocaleString()}\n` +
    `cache write:  ${usage.cacheCreationTokens.toLocaleString()}\n` +
    `cache read:   ${usage.cacheReadTokens.toLocaleString()}\n` +
    `─────────────────────\n` +
    `total:        ${totalTokens.toLocaleString()}\n\n` +
    `est. API cost (informational — subscription billing):\n` +
    `  ${formatCost(cost)}`;

  return (
    <div className="relative shrink-0 border-t border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5" title="Active orchestrator model">
          <span className="text-foreground/50">model</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
            {model ?? '—'}
          </span>
        </span>

        <span className="text-foreground/20">│</span>

        <span
          className="flex items-center gap-1.5 tabular-nums"
          title={hasUsage ? usageTitle : 'No tokens used yet this session'}
        >
          <span className="text-foreground/50">tokens</span>
          <span className="text-foreground">{formatTokens(totalTokens)}</span>
          <span className="text-foreground/30">·</span>
          <span className="text-foreground">{formatCost(cost)}</span>
          <span className="text-foreground/40">est.</span>
        </span>

        <span className="text-foreground/20">│</span>

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
            className={`inline-block h-2 w-2 rounded-full ${
              mcp?.alive ? 'bg-emerald-500' : 'bg-zinc-500'
            }`}
            aria-hidden
          />
          <span className="text-foreground/50">MCP</span>
          <span className="tabular-nums text-foreground">
            {mcp === null
              ? '…'
              : mcp.alive
                ? `${mcp.toolCount} tools`
                : 'offline'}
          </span>
        </button>

        <span
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5"
          title={WS_PILL[wsStatus].title}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${WS_PILL[wsStatus].dot}`}
            aria-hidden
          />
          <span className="text-foreground/50">WS</span>
          <span className="tabular-nums text-foreground">{WS_PILL[wsStatus].label}</span>
        </span>

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
