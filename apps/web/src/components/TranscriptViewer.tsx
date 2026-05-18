// Minimal read-only viewer for a subagent's CC JSONL transcript (Section 3 / 3g).
//
// Fetched via GET /api/subagent-transcript?path=...  (server path-guards to
// `~/.claude/projects/`). Renders one row per JSONL line:
//   • assistant text (markdown-ish, plain pre)
//   • tool calls (tool name + input)
//   • tool results (clipped)
//   • everything else (collapsed by default — type + raw JSON)
//
// Nothing here is interactive. Failure surfacing (Section 3 D10) is the only
// caller; future sections may grow this into a full transcript explorer.

import { useEffect, useMemo, useState } from 'react';

interface TranscriptViewerProps {
  path: string;
  onClose: () => void;
}

interface TranscriptResponse {
  ok: boolean;
  path?: string;
  relPath?: string;
  events?: unknown[];
  error?: string;
}

export function TranscriptViewer({ path, onClose }: TranscriptViewerProps) {
  const [state, setState] = useState<TranscriptResponse | { loading: true } | { error: string }>(
    { loading: true },
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/subagent-transcript?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const body = (await r.json()) as TranscriptResponse;
        if (cancelled) return;
        if (!body.ok) setState({ error: body.error ?? `HTTP ${r.status}` });
        else setState(body);
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
      <div className="flex h-[90vh] w-[90vw] max-w-4xl flex-col border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-wider">Subagent transcript</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">{path}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border border-border px-3 py-1 text-xs hover:bg-muted"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {'loading' in state && (
            <div className="text-xs text-muted-foreground">Loading transcript…</div>
          )}
          {'error' in state && (
            <div className="text-xs text-destructive">Failed to load: {state.error}</div>
          )}
          {'ok' in state && state.ok && state.events && (
            <TranscriptBody events={state.events} />
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptBody({ events }: { events: unknown[] }) {
  const rendered = useMemo(() => events.map((e, i) => renderEvent(e, i)), [events]);
  if (rendered.length === 0) {
    return <div className="text-xs text-muted-foreground">Transcript is empty.</div>;
  }
  return <div className="space-y-2">{rendered}</div>;
}

function renderEvent(raw: unknown, idx: number) {
  if (!raw || typeof raw !== 'object') {
    return <RawRow key={idx} idx={idx} label="unknown" raw={raw} />;
  }
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : '?';

  // CC's per-session JSONL message rows look like { type:'assistant', message:{ role, content:[...] } }
  if (type === 'assistant' || type === 'user') {
    const message = obj.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message?.content as unknown[]) : null;
    return (
      <div key={idx} className="border-l-2 border-border pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          {type}
        </div>
        {content ? (
          <div className="space-y-1">
            {content.map((block, j) => renderBlock(block, `${idx}-${j}`))}
          </div>
        ) : (
          <RawRow idx={idx} label={type} raw={raw} />
        )}
      </div>
    );
  }

  // System / summary / anything else — collapsed by default.
  return <RawRow key={idx} idx={idx} label={type} raw={raw} />;
}

function renderBlock(block: unknown, key: string) {
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  const blockType = typeof b.type === 'string' ? b.type : '?';

  if (blockType === 'text' && typeof b.text === 'string') {
    return (
      <pre
        key={key}
        className="whitespace-pre-wrap break-words bg-muted/20 px-2 py-1 font-mono text-[11px]"
      >
        {b.text}
      </pre>
    );
  }

  if (blockType === 'tool_use') {
    return (
      <div key={key} className="bg-muted/20 px-2 py-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          tool_use · <span className="font-mono">{String(b.name ?? '?')}</span>
        </div>
        <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px]">
          {safeJson(b.input)}
        </pre>
      </div>
    );
  }

  if (blockType === 'tool_result') {
    const content = b.content;
    const text = typeof content === 'string' ? content : safeJson(content);
    const isError = b.is_error === true;
    return (
      <div
        key={key}
        className={`px-2 py-1 ${isError ? 'bg-destructive/10' : 'bg-muted/20'}`}
      >
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          tool_result{isError ? ' · ERROR' : ''}
        </div>
        <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px]">
          {text}
        </pre>
      </div>
    );
  }

  if (blockType === 'thinking' && typeof b.thinking === 'string') {
    return (
      <div key={key} className="bg-muted/10 px-2 py-1 text-[10px] italic text-muted-foreground">
        <div className="uppercase tracking-wider">thinking</div>
        <pre className="mt-0.5 whitespace-pre-wrap break-words">{b.thinking}</pre>
      </div>
    );
  }

  return (
    <pre
      key={key}
      className="max-h-40 overflow-auto whitespace-pre-wrap break-words bg-muted/10 px-2 py-1 font-mono text-[10px]"
    >
      {safeJson(block)}
    </pre>
  );
}

function RawRow({ idx, label, raw }: { idx: number; label: string; raw: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l-2 border-border pl-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-left text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {open ? '▾' : '▸'} {label} #{idx}
      </button>
      {open && (
        <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px]">
          {safeJson(raw)}
        </pre>
      )}
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
