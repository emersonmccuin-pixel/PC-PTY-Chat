/** Sentinel exit code: child exits with this to ask the supervisor to respawn. */
export const DEV_RESTART_EXIT_CODE = 75;

/**
 * True only in DEV-RUN (server started via the supervisor outside a packaged
 * Electron build). Packaged Electron sets `PC_ROOT` before importing the
 * server bundle; absence of that var is the "dev" signal — same heuristic
 * the server uses for `ROOT` resolution in `src/index.ts`.
 */
export function isDevControlsEnabled(): boolean {
  return !process.env['PC_ROOT'];
}
