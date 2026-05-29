import type { Hono } from 'hono';

import { getActiveRunRegistry } from '../../services/agent-active-runs.ts';
import { DEV_RESTART_EXIT_CODE, isDevControlsEnabled } from './constants.ts';

export interface DevControlDeps {
  gracefulShutdown(): void;
}

export function registerDevControlRoutes(app: Hono, deps: DevControlDeps): void {
  if (!isDevControlsEnabled()) return;

  /** GET /api/dev/canary — pipeline smoke test, safe to revert. */
  // CANARY pipeline test — safe to revert
  app.get('/api/dev/canary', (c) => c.json({ ok: true, marker: 'canary-1' }));

  // CANARY-4 pipeline test — safe to revert
  app.get('/api/dev/canary4', (c) => c.json({ ok: true, marker: 'canary-4' }));

  /** GET /api/dev/status — active-agent count + whether a restart is safe. */
  app.get('/api/dev/status', (c) => {
    const activeAgents = getActiveRunRegistry().list().length;
    // TEMP reload-test marker — bump the number and hit restart to confirm the
    // supervisor respawn picks up BE source changes. Remove after testing.
    return c.json({ activeAgents, canRestart: activeAgents === 0, marker: 'BE-RELOAD-TEST-1' });
  });

  /**
   * POST /api/dev/restart — graceful shutdown then exit(75) so the supervisor
   * respawns a fresh tsx child.
   *
   * Returns 409 when agents are live unless `force: true` is in the body.
   */
  app.post('/api/dev/restart', async (c) => {
    let force = false;
    try {
      const body = await c.req.json<{ force?: boolean }>();
      force = body.force === true;
    } catch {
      // empty or malformed body → force stays false
    }

    const activeAgents = getActiveRunRegistry().list().length;
    if (activeAgents > 0 && !force) {
      return c.json(
        {
          ok: false,
          error: `${activeAgents} agent(s) active — pass force:true to restart anyway`,
        },
        409,
      );
    }

    // Flush the response before exiting. setTimeout gives the HTTP stack one
    // event-loop tick to send the 200 back to the client.
    setTimeout(() => {
      deps.gracefulShutdown();
      process.exit(DEV_RESTART_EXIT_CODE);
    }, 50);

    return c.json({ ok: true });
  });
}
