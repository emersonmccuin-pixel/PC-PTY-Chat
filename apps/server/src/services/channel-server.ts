// Channel server. Single multiplexed HTTP listener on :8788 plus a WS registry
// of per-project channel-stdio children. Replaces the rig-era per-process model
// where each channel-server.js bound its own port — see docs/design/multi-tenancy.md
// §3 for the locked routing.
//
// External callers POST to `/channel/<slug>/<source>` with a plain text body.
// We resolve the slug → projectId via the registry, fan the event to the
// matching child's WS so it can re-emit it as an MCP notification to its
// claude.exe. UI subscribers are notified separately via the project's WS
// broadcast envelope.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { getProjectBySlug } from '@pc/db';
import type { Project, ULID } from '@pc/domain';

export interface ChannelServerDeps {
  /** Port for the HTTP listener (locked: 8788). */
  port: number;
  /** Allowlisted X-Sender values. Empty set means everyone is allowed. */
  allowedSenders: Set<string>;
  /** Pushes a UI-side broadcast for a channel event arriving at this project. */
  onEvent: (projectId: ULID, payload: ChannelEvent) => void;
}

export interface ChannelEvent {
  projectId: ULID;
  slug: string;
  source: string;
  body: string;
  sender: string;
  at: number;
}

interface RegisteredChild {
  ws: WebSocket;
  projectId: ULID;
  slug: string;
}

export class ChannelServer {
  private readonly registrants = new Map<ULID, RegisteredChild>();
  private httpServer: ReturnType<typeof serve> | null = null;
  private wss: WebSocketServer | null = null;

  constructor(private readonly deps: ChannelServerDeps) {}

  /** Start the HTTP + WS listeners. Returns once bound. */
  start(): void {
    const app = new Hono();

    // POST /channel/:slug/:source — external webhook entry. Looks up the
    // project by slug, validates the sender, routes the body to the registered
    // child for that project, and emits a UI broadcast.
    app.post('/channel/:slug/:source', async (c) => {
      const slug = c.req.param('slug');
      const source = c.req.param('source');
      const sender = c.req.header('x-sender') ?? '';
      if (this.deps.allowedSenders.size > 0 && !this.deps.allowedSenders.has(sender)) {
        return c.text('forbidden', 403);
      }
      const project = getProjectBySlug(slug);
      if (!project) return c.text(`unknown project slug: ${slug}`, 404);

      const body = await c.req.text();
      const event: ChannelEvent = {
        projectId: project.id,
        slug,
        source,
        body,
        sender,
        at: Date.now(),
      };
      this.forwardToChild(project, event);
      this.deps.onEvent(project.id, event);
      return c.text('ok', 200);
    });

    app.get('/health', (c) =>
      c.json({ ok: true, registrants: Array.from(this.registrants.keys()) }),
    );

    this.httpServer = serve(
      { fetch: app.fetch, port: this.deps.port, hostname: '127.0.0.1' },
      (info) => {
        console.log(`[channel] http://127.0.0.1:${info.port}`);
      },
    );

    this.wss = new WebSocketServer({ server: this.httpServer as never, path: '/channel-register' });
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '/channel-register', 'http://127.0.0.1');
      const projectId = url.searchParams.get('projectId') as ULID | null;
      const slug = url.searchParams.get('slug') ?? '';
      if (!projectId || !slug) {
        try { ws.close(1008, 'projectId and slug required'); } catch { /* best effort */ }
        return;
      }
      const prior = this.registrants.get(projectId);
      if (prior) {
        try { prior.ws.close(1000, 'superseded by newer registrant'); } catch { /* best effort */ }
      }
      this.registrants.set(projectId, { ws, projectId, slug });
      console.log(`[channel] registered ${slug} (${projectId})`);
      ws.on('close', () => {
        const cur = this.registrants.get(projectId);
        if (cur && cur.ws === ws) this.registrants.delete(projectId);
      });
    });
  }

  shutdown(): void {
    for (const r of this.registrants.values()) {
      try { r.ws.close(1001, 'channel server shutting down'); } catch { /* best effort */ }
    }
    this.registrants.clear();
    try { this.wss?.close(); } catch { /* best effort */ }
    try { this.httpServer?.close(); } catch { /* best effort */ }
  }

  /** Section 16b — Programmatic emit. Server-side code (agent comms,
   *  workflow runtime) calls this to deliver a synthesised event directly
   *  to the registered child + UI subscribers, without round-tripping
   *  through the HTTP listener. Returns true if a registered child
   *  received the forward; false if no child was registered (event still
   *  propagates to UI subscribers via `onEvent`). */
  emitToProject(args: {
    projectId: ULID;
    slug: string;
    source: string;
    body: string;
    sender?: string;
  }): boolean {
    const event: ChannelEvent = {
      projectId: args.projectId,
      slug: args.slug,
      source: args.source,
      body: args.body,
      sender: args.sender ?? 'pc',
      at: Date.now(),
    };
    const child = this.registrants.get(args.projectId);
    const delivered = !!(child && child.ws.readyState === child.ws.OPEN);
    if (delivered) {
      child!.ws.send(
        JSON.stringify({
          type: 'channel-event',
          content: event.body,
          path: `/channel/${event.slug}/${event.source}`,
          method: 'POST',
          source: event.source,
        }),
      );
    } else {
      console.warn(
        `[channel] emitToProject: no registered child for ${args.projectId}; UI broadcast only`,
      );
    }
    this.deps.onEvent(args.projectId, event);
    return delivered;
  }

  private forwardToChild(project: Project, event: ChannelEvent): void {
    const child = this.registrants.get(project.id);
    if (!child || child.ws.readyState !== child.ws.OPEN) {
      console.warn(
        `[channel] no registered child for ${project.id} (${project.name}); dropping event from ${event.source}`,
      );
      return;
    }
    child.ws.send(
      JSON.stringify({
        type: 'channel-event',
        content: event.body,
        path: `/channel/${event.slug}/${event.source}`,
        method: 'POST',
        source: event.source,
      }),
    );
  }
}
