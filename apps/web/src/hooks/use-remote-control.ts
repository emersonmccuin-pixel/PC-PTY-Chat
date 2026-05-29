// Section 31.10 — derive remote-control state from the per-project WS event
// stream. Three JSONL signals compose:
//   • `type:'bridge-session'`           → carries the `bridgeSessionId`
//   • `system:bridge_status`            → connection announcement + `url`
//   • `system:informational` "Remote
//     Control disconnected: …"          → disconnect notice
//
// session-changed clears state (new CC session starts disconnected).
//
// Empirical row shapes (from real CC v2.1.150 JSONL on 2026-05-25):
//   { type:"bridge-session", bridgeSessionId:"cse_01M…", … }
//   { type:"system", subtype:"bridge_status", url:"https://claude.ai/code/session_01M…", content:"/remote-control is active · …" }
//   { type:"system", subtype:"informational", content:"Remote Control disconnected: Transport closed (code 4090)" }

import { useMemo } from 'react';

import type { JsonlEvent, WsEnvelope } from '@/features/runtime/ws-types';

export interface RemoteControlState {
  active: boolean;
  url: string | null;
  bridgeSessionId: string | null;
}

const EMPTY: RemoteControlState = { active: false, url: null, bridgeSessionId: null };

export function useRemoteControl(events: WsEnvelope[]): RemoteControlState {
  return useMemo(() => {
    let active = false;
    let url: string | null = null;
    let bridgeSessionId: string | null = null;

    for (const env of events) {
      if (env.type === 'session-changed') {
        active = false;
        url = null;
        bridgeSessionId = null;
        continue;
      }
      if (env.type !== 'jsonl') continue;
      const ev = env.event as JsonlEvent | undefined;
      if (!ev || typeof ev !== 'object') continue;

      if (ev.kind === 'jsonl-bridge-session') {
        bridgeSessionId = ev.bridgeSessionId;
        if (!ev.bridgeSessionId) {
          // Some CC builds emit a null bridge-session row at session-end.
          active = false;
          url = null;
        }
        continue;
      }

      if (ev.kind === 'jsonl-system') {
        if (ev.subtype === 'bridge_status') {
          active = true;
          const raw = ev.raw as { url?: unknown } | undefined;
          if (raw && typeof raw.url === 'string') url = raw.url;
          continue;
        }
        if (
          ev.subtype === 'informational' &&
          typeof ev.message === 'string' &&
          ev.message.toLowerCase().includes('remote control disconnected')
        ) {
          active = false;
          url = null;
          continue;
        }
      }
    }

    if (!active && !bridgeSessionId && !url) return EMPTY;
    return { active, url, bridgeSessionId };
  }, [events]);
}
