import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const OVERLAP_SCAN_BYTES = 64 * 1024;

interface TerminalModePanelProps {
  projectId: string;
  sessionId: string | null;
  events: WsEnvelope[];
  visible: boolean;
  writable: boolean;
  onInput: (data: string) => boolean;
  onResize: (cols: number, rows: number) => boolean;
}

export function TerminalModePanel({
  projectId,
  sessionId,
  events,
  visible,
  writable,
  onInput,
  onResize,
}: TerminalModePanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitTargetRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const dataDisposableRef = useRef<{ dispose(): void } | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const eventsRef = useRef(events);
  const lastTerminalSeqRef = useRef(0);
  const attachingRef = useRef(false);
  const attachLiveBufferRef = useRef('');
  const writeQueueRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const writableRef = useRef(writable);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const [readyToReveal, setReadyToReveal] = useState(false);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  useEffect(() => {
    writableRef.current = writable;
    const term = termRef.current;
    if (term) term.options.disableStdin = !writable;
  }, [writable]);
  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  const flushWrites = useCallback(() => {
    rafRef.current = null;
    const text = writeQueueRef.current;
    writeQueueRef.current = '';
    if (!text) return;
    termRef.current?.write(text);
    if ((window as Window & { __PC_TERMINAL_TEST_HOOK__?: boolean }).__PC_TERMINAL_TEST_HOOK__) {
      window.dispatchEvent(new CustomEvent('pc:terminal-write', { detail: { text } }));
    }
  }, []);

  const enqueueWrite = useCallback((text: string) => {
    if (!text) return;
    writeQueueRef.current += text;
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(flushWrites);
  }, [flushWrites]);

  const fitAndResize = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return false;
    try {
      fit.fit();
      const next = { cols: term.cols, rows: term.rows };
      onResizeRef.current(next.cols, next.rows);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!sessionId || !hostRef.current) return;
    const sessionKey = `${projectId}:${sessionId}`;
    if (sessionKeyRef.current === sessionKey && termRef.current) return;

    disposeTerminal();
    sessionKeyRef.current = sessionKey;
    lastTerminalSeqRef.current = maxTerminalSeq(eventsRef.current, sessionId);
    attachingRef.current = true;
    attachLiveBufferRef.current = '';
    setReadyToReveal(false);

    const term = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      disableStdin: !writableRef.current,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    dataDisposableRef.current = term.onData((data) => {
      if (!writableRef.current) return;
      onInputRef.current(data);
    });

    let cancelled = false;
    void api
      .getTerminalTranscript(projectId, sessionId, TRANSCRIPT_TAIL_BYTES)
      .then((transcript) => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        const live = attachLiveBufferRef.current;
        attachLiveBufferRef.current = '';
        enqueueWrite(transcript.bytes);
        enqueueWrite(removeOverlappingPrefix(transcript.bytes, live));
      })
      .catch(() => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
      })
      .finally(() => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        attachingRef.current = false;
      });

    return () => {
      cancelled = true;
    };
    // Terminal lifetime is keyed only by project/session. Event and callback
    // freshness flows through refs above so rerenders cannot duplicate listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, enqueueWrite]);

  useEffect(() => {
    if (!sessionId) {
      disposeTerminal();
      sessionKeyRef.current = null;
      lastTerminalSeqRef.current = 0;
      setReadyToReveal(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const pending: Array<{ seq: number; text: string }> = [];
    for (const env of events) {
      const raw = terminalRawFromEnvelope(env, sessionId);
      if (!raw || raw.seq <= lastTerminalSeqRef.current) continue;
      pending.push(raw);
    }
    pending.sort((a, b) => a.seq - b.seq);
    for (const raw of pending) {
      if (attachingRef.current) {
        attachLiveBufferRef.current += raw.text;
      } else {
        enqueueWrite(raw.text);
      }
      lastTerminalSeqRef.current = Math.max(lastTerminalSeqRef.current, raw.seq);
    }
  }, [events, enqueueWrite, sessionId]);

  useEffect(() => {
    const target = fitTargetRef.current;
    if (!target) return;
    const observer = new ResizeObserver(() => {
      if (!visible) return;
      fitAndResize();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fitAndResize, visible]);

  useEffect(() => {
    if (!visible) {
      setReadyToReveal(false);
      return;
    }
    setReadyToReveal(false);
    let second: number | null = null;
    const first = window.requestAnimationFrame(() => {
      fitAndResize();
      second = window.requestAnimationFrame(() => {
        setReadyToReveal(true);
        termRef.current?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second !== null) window.cancelAnimationFrame(second);
    };
  }, [visible, fitAndResize]);

  useEffect(() => {
    return () => disposeTerminal();
  }, []);

  return (
    <div
      data-testid="terminal-mode-panel"
      className={
        'absolute inset-0 bg-[#050505] transition-opacity duration-100 ' +
        (visible ? 'pointer-events-auto' : 'pointer-events-none invisible') +
        (visible && readyToReveal ? ' opacity-100' : ' opacity-0')
      }
      aria-hidden={!visible}
    >
      <div
        ref={fitTargetRef}
        data-testid="terminal-mode-fit-target"
        className="h-full w-full overflow-hidden bg-[#050505]"
      >
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );

  function disposeTerminal() {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    writeQueueRef.current = '';
    attachLiveBufferRef.current = '';
    attachingRef.current = false;
    dataDisposableRef.current?.dispose();
    dataDisposableRef.current = null;
    fitRef.current?.dispose();
    fitRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
  }
}

function terminalTheme() {
  return {
    background: '#050505',
    foreground: '#d6d6d6',
    cursor: '#f8f8f2',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  };
}

function terminalRawFromEnvelope(
  env: WsEnvelope | undefined,
  sessionId: string,
): { seq: number; text: string } | null {
  if (!env || env.type !== 'raw' || typeof env.text !== 'string') return null;
  if (env.sessionId !== sessionId) return null;
  const seq = env.terminalSeq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return null;
  return { seq, text: env.text };
}

function maxTerminalSeq(events: WsEnvelope[], sessionId: string): number {
  let max = 0;
  for (const env of events) {
    const raw = terminalRawFromEnvelope(env, sessionId);
    if (raw) max = Math.max(max, raw.seq);
  }
  return max;
}

function removeOverlappingPrefix(previous: string, next: string): string {
  if (!previous || !next) return next;
  const prevTail = previous.slice(-OVERLAP_SCAN_BYTES);
  const max = Math.min(prevTail.length, next.length);
  for (let len = max; len > 0; len--) {
    if (prevTail.endsWith(next.slice(0, len))) {
      return next.slice(len);
    }
  }
  return next;
}
