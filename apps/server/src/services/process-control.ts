// OS process liveness + kill helpers for the in-process agent runtime.
//
// Used by the continuous liveness sweep (probe + kill wedged runs) and the
// operator hard-kill path (force-end a run's real process). Centralized so the
// "is it alive / make it dead" logic has one cross-platform definition.

import { execFile } from 'node:child_process';

/**
 * Is the OS process `pid` still alive?
 *
 * `process.kill(pid, 0)` sends no signal — it only runs the kernel's
 * permission/existence check. ESRCH = no such process (dead). EPERM = exists
 * but we lack permission to signal it (still alive). Anything else: assume
 * alive to stay conservative (never report a maybe-live run as dead).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Force-kill a process and (on Windows) its child tree. node-pty spawns
 * claude.exe which itself spawns children; a bare `process.kill` can orphan
 * them, so on Windows we use `taskkill /T /F`. Best-effort + fire-and-forget:
 * the caller finalizes the DB row regardless of whether the OS kill races.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    // /T = tree (kill children too), /F = force. execFile (no shell) avoids
    // quoting pitfalls. Errors (already-dead) are swallowed.
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
      /* best-effort */
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already dead */
  }
}
