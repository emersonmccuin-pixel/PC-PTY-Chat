// Dev-only: React 19's dev build emits a `performance.measure(...)` per
// component render to feed the DevTools "Performance" track (logComponentRender).
// React never clears these and StrictMode doubles them, so over a long dev
// session the buffer grows unbounded and eventually OOMs the renderer mid-commit
// (DataCloneError "out of memory" → reconciler corruption → reload).
// Periodically drop accumulated measures/marks to bound the buffer. No-op in prod.
export function installDevPerfBufferReaper(): void {
  if (!import.meta.env.DEV) return;
  if (typeof performance?.clearMeasures !== 'function') return;
  setInterval(() => {
    performance.clearMeasures();
    performance.clearMarks();
  }, 30_000);
}
