// Preload — runs with contextIsolation in the renderer's privileged world.
// PC's web bundle talks to the server over HTTP/WS on the same origin, so the
// renderer needs no Node bridge today. We expose a minimal, namespaced surface
// the UI can feature-detect to know it's running inside the desktop shell
// (used by Phase 2's onboarding gate to skip the "you need to install PC"
// framing). Keep this lean — every exposed symbol is attack surface.

import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('pcDesktop', {
  isDesktop: true,
  platform: process.platform,
});
