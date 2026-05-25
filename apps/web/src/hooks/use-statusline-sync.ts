// Section 31.7 — walk the WS envelope stream and push `statusline-snapshot`
// payloads into the per-project statusline store. Mount once at Shell level
// alongside the rich-link invalidator.

import { useEffect, useRef } from 'react';

import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { type StatuslineSnapshot, useStatuslineStore } from '@/store/statusline';

export function useStatuslineSync(projectId: string | null, events: WsEnvelope[]): void {
  const lastIdx = useRef(0);

  // Reset envelope-scan cursor when project changes; also prime the store
  // with the server's latest cached snapshot so the rail isn't blank on
  // first paint after the user opens PC mid-session.
  useEffect(() => {
    lastIdx.current = 0;
    if (!projectId) return;
    let cancelled = false;
    api
      .getStatuslineSnapshot(projectId)
      .then((snap) => {
        if (cancelled || !snap) return;
        useStatuslineStore.getState().set(projectId, snap as StatuslineSnapshot);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    for (let i = lastIdx.current; i < events.length; i++) {
      const env = events[i];
      if (!env || typeof env !== 'object') continue;
      if (env.type === 'statusline-snapshot') {
        const snap = (env as { snapshot?: StatuslineSnapshot }).snapshot;
        if (snap) useStatuslineStore.getState().set(projectId, snap);
      }
    }
    lastIdx.current = events.length;
  }, [events, projectId]);
}
