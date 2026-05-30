import { test, expect, type Page, type Route } from '@playwright/test';

const PROJECT_ID = 'proj-terminal-mode';
const PROJECT_SLUG = 'terminal-mode-smoke';
const SESSION_ID = 'sess-terminal-mode';
const WORKFLOW_BUILDER_SESSION_ID = 'wb-terminal-mode';

type Surface = 'chat' | 'terminal';
type CenterTab = 'orchestrator' | 'workflows';
type TransientSessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

declare global {
  interface Window {
    __PC_TERMINAL_TEST_HOOK__?: boolean;
    __terminalWrites?: string[];
    __terminalWsMessages?: unknown[];
    __terminalBroadcast?: (message: Record<string, unknown>) => void;
    __terminalWs?: EventTarget & { emit(message: Record<string, unknown>): void };
  }
}

const project = {
  id: PROJECT_ID,
  slug: PROJECT_SLUG,
  name: 'Terminal Mode Smoke',
  folderPath: 'C:\\tmp\\terminal-mode-smoke',
  gitRemote: null,
  settings: { cancelledVisibility: 'use-global' },
  stages: [
    { id: 'stage-new', name: 'New', order: 0, isNew: true },
    { id: 'stage-done', name: 'Done', order: 1, isDone: true },
  ],
};

const session = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  provider: 'claude',
  providerSessionId: null,
  model: null,
  title: 'Terminal smoke session',
  status: 'active',
  endedReason: null,
  startedAt: Date.now(),
  endedAt: null,
  deletedAt: null,
};

function settings(defaultSurface: Surface) {
  return {
    dataDir: 'C:\\tmp\\pc-data',
    telemetryOptIn: false,
    claudeConfigDir: null,
    defaultOrchestratorSurface: defaultSurface,
    projectsFolder: 'C:\\tmp',
    activityPanel: { open: false, showAllProjects: false },
    bugLogTargetProjectId: null,
    fontScale: 1,
    hideCancelledStage: false,
    onboardingCompletedAt: '2026-05-27T00:00:00.000Z',
  };
}

function runtimeSnapshot() {
  return {
    type: 'runtime-state',
    sessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: null,
    health: 'ready',
    waitPoint: 'none',
    ptyState: 'ready',
    exitCode: null,
    exitSignal: null,
    spawnAttemptId: null,
    spawnAttempt: 0,
    lastReadyAt: Date.now(),
    nextRetryAt: null,
    lastExitAt: null,
    lastJsonlAt: null,
    lastActivityAt: Date.now(),
    failureReason: null,
    rawJsonlPath: null,
    rawJsonlExists: false,
    rawJsonlCursor: null,
    replayPath: null,
    replayExists: false,
    replayLineCount: 0,
    replayHighWaterSeq: 0,
    queueDepth: 0,
    queue: [],
  };
}

async function setupTerminalHarness(
  page: Page,
  defaultSurface: Surface,
  options: {
    initialMode?: Surface | null;
    initialTab?: CenterTab;
    workflowBuilderState?: TransientSessionState;
  } = {},
) {
  let currentSettings = settings(defaultSurface);

  await page.route('**/api/**', async (route) => {
    await fulfillApi(
      route,
      currentSettings,
      (next) => {
        currentSettings = next;
      },
      options.workflowBuilderState ?? 'ready',
    );
  });

  await page.addInitScript(
    ({ projectId, projectSlug, sessionId, initialMode, initialTab }) => {
      const activeProjectKey = 'pc.active-project';
      const activeTabKey = 'pc.center-tab';
      const modeKey = `pc.terminal-mode.${projectId}.${sessionId}`;

      localStorage.setItem(
        activeProjectKey,
        JSON.stringify({ state: { activeSlug: projectSlug }, version: 0 }),
      );
      localStorage.setItem(
        activeTabKey,
        JSON.stringify({ state: { tab: initialTab }, version: 0 }),
      );
      if (!sessionStorage.getItem('terminal-mode-smoke-init')) {
        if (initialMode === null || initialMode === undefined) {
          localStorage.removeItem(modeKey);
        } else {
          localStorage.setItem(modeKey, initialMode);
        }
        sessionStorage.setItem('terminal-mode-smoke-init', '1');
      }

      (window as typeof window & {
        __PC_TERMINAL_TEST_HOOK__?: boolean;
        __terminalWrites?: string[];
        __terminalWsMessages?: unknown[];
        __terminalBroadcast?: (message: Record<string, unknown>) => void;
        __terminalWs?: EventTarget & { emit(message: Record<string, unknown>): void };
      }).__PC_TERMINAL_TEST_HOOK__ = true;
      window.__terminalWrites = [];
      window.__terminalWsMessages = [];
      window.addEventListener('pc:terminal-write', (event) => {
        const detail = (event as CustomEvent<{ text?: unknown }>).detail;
        if (typeof detail?.text === 'string') window.__terminalWrites?.push(detail.text);
      });

      class FakeWebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        url: string;
        readyState = FakeWebSocket.CONNECTING;

        constructor(url: string) {
          super();
          this.url = url;
          window.__terminalWs = this;
          setTimeout(() => {
            this.readyState = FakeWebSocket.OPEN;
            this.dispatchEvent(new Event('open'));
            this.emit({ projectId, type: 'session-changed', session: { id: sessionId, projectId } });
            this.emit({
              projectId,
              type: 'runtime-state',
              sessionId,
              provider: 'claude',
              providerSessionId: null,
              health: 'ready',
              waitPoint: 'none',
              ptyState: 'ready',
              exitCode: null,
              exitSignal: null,
              spawnAttemptId: null,
              spawnAttempt: 0,
              lastReadyAt: Date.now(),
              nextRetryAt: null,
              lastExitAt: null,
              lastJsonlAt: null,
              lastActivityAt: Date.now(),
              failureReason: null,
              rawJsonlPath: null,
              rawJsonlExists: false,
              rawJsonlCursor: null,
              replayPath: null,
              replayExists: false,
              replayLineCount: 0,
              replayHighWaterSeq: 0,
              queueDepth: 0,
              queue: [],
            });
            this.emit({ projectId, type: 'session-replay', sessionId, highWaterSeq: 0, events: [] });
            this.emit({ projectId, type: 'send-queue-snapshot', sessionId, items: [] });
          }, 0);
        }

        send(data: string) {
          try {
            window.__terminalWsMessages?.push(JSON.parse(data));
          } catch {
            window.__terminalWsMessages?.push(data);
          }
        }

        close() {
          this.readyState = FakeWebSocket.CLOSED;
          this.dispatchEvent(new CloseEvent('close'));
        }

        emit(message: Record<string, unknown>) {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
        }
      }

      window.__terminalBroadcast = (message) => window.__terminalWs?.emit(message);
      window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    },
    {
      projectId: PROJECT_ID,
      projectSlug: PROJECT_SLUG,
      sessionId: SESSION_ID,
      initialMode: options.initialMode,
      initialTab: options.initialTab ?? 'orchestrator',
    },
  );
}

async function fulfillApi(
  route: Route,
  currentSettings: ReturnType<typeof settings>,
  updateSettings: (next: ReturnType<typeof settings>) => void,
  workflowBuilderState: TransientSessionState,
) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();

  if (!path.startsWith('/api/')) {
    return route.continue();
  }

  const json = (body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

  if (path === '/api/projects') {
    return json({ projects: [project] });
  }
  if (path === '/api/settings' && method === 'GET') {
    return json({ ok: true, settings: currentSettings });
  }
  if (path === '/api/settings' && method === 'PATCH') {
    const patch = JSON.parse(request.postData() || '{}') as Partial<ReturnType<typeof settings>>;
    const next = { ...currentSettings, ...patch };
    updateSettings(next);
    return json({ ok: true, settings: next, restartRequired: false });
  }
  if (path === `/api/projects/${PROJECT_ID}/session`) {
    return json({ ok: true, session });
  }
  if (path === `/api/projects/${PROJECT_ID}/orchestrator/runtime`) {
    return json({ ok: true, runtime: runtimeSnapshot() });
  }
  if (path === `/api/projects/${PROJECT_ID}/statusline`) {
    return json({ ok: true, snapshot: null });
  }
  if (path === `/api/projects/${PROJECT_ID}/agent-runs`) {
    return json({ ok: true, runs: [] });
  }
  if (path === `/api/projects/${PROJECT_ID}/workflow-v2/runs`) {
    return json({ ok: true, runs: [] });
  }
  if (path === '/api/workflows') {
    return json({ ok: true, workflows: [] });
  }
  if (path === `/api/projects/${PROJECT_ID}/workflow-builder/start`) {
    return json({ ok: true, state: workflowBuilderState, sessionId: WORKFLOW_BUILDER_SESSION_ID });
  }
  if (path === `/api/projects/${PROJECT_ID}/sessions/${WORKFLOW_BUILDER_SESSION_ID}/terminal-transcript`) {
    return json({
      ok: true,
      sessionId: WORKFLOW_BUILDER_SESSION_ID,
      bytes: 'WORKFLOW_BOOT\r\n',
      truncated: false,
      mtimeMs: Date.now(),
    });
  }
  if (path === `/api/projects/${PROJECT_ID}/failed-run-dismissals`) {
    return json({ ok: true, runIds: [] });
  }
  if (path === `/api/projects/${PROJECT_ID}/work-items`) {
    return json({ workItems: [] });
  }
  if (path === `/api/projects/${PROJECT_ID}/sessions`) {
    return json({ ok: true, sessions: [session] });
  }
  if (path === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/terminal-transcript`) {
    return json({
      ok: true,
      sessionId: SESSION_ID,
      bytes: 'BOOT_TRANSCRIPT\r\n',
      truncated: false,
      mtimeMs: Date.now(),
    });
  }
  return json({ ok: true });
}

async function gotoHarnessShell(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Terminal Mode Smoke', exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="chat-mode-toggle"]')).toBeVisible({ timeout: 10_000 });
}

async function terminalWrites(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__terminalWrites ?? []);
}

async function terminalInputPayload(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window.__terminalWsMessages ?? [])
      .filter((message): message is { type: string; data: string } =>
        !!message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'terminal-input' &&
        typeof (message as { data?: unknown }).data === 'string',
      )
      .map((message) => message.data)
      .join(''),
  );
}

test.describe('Terminal mode smoke', () => {
  test('default terminal starts in xterm, hides composer, and does not duplicate input/listeners', async ({ page }) => {
    await setupTerminalHarness(page, 'terminal');
    await gotoHarnessShell(page);

    const terminal = page.locator('[data-testid="terminal-mode-panel"]');
    await expect(terminal).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="chat-composer-input"]')).toHaveCount(0);
    await expect.poll(() => terminalWrites(page), { timeout: 10_000 }).toContain('BOOT_TRANSCRIPT\r\n');
    await expect(page.locator('.xterm')).toHaveCount(1);

    const toggle = page.locator('[data-testid="chat-mode-toggle"]');
    await toggle.click();
    await expect(page.locator('[data-testid="chat-composer-input"]')).toBeVisible();
    await expect(terminal).toBeHidden();
    await toggle.click();
    await expect(terminal).toBeVisible();
    await toggle.click();
    await toggle.click();
    await expect(page.locator('.xterm')).toHaveCount(1);

    const beforeTypeWrites = (await terminalWrites(page)).length;
    await page.locator('[data-testid="terminal-mode-fit-target"]').click();
    await page.keyboard.type('abc');
    await expect.poll(() => terminalInputPayload(page), { timeout: 5_000 }).toBe('abc');
    expect((await terminalWrites(page)).length).toBe(beforeTypeWrites);

    await page.evaluate(() => {
      window.__terminalWsMessages = [];
    });
    await page.locator('[data-testid="terminal-mode-fit-target"]').click();
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => terminalInputPayload(page), { timeout: 5_000 }).toBe('\n');

    await page.evaluate(() => {
      window.__terminalWrites = [];
    });
    await page.evaluate(
      ({ projectId, sessionId }) =>
        window.__terminalBroadcast?.({
          projectId,
          sessionId,
          type: 'raw',
          terminalSeq: 1,
          text: 'RAW_ONCE\r\n',
        }),
      { projectId: PROJECT_ID, sessionId: SESSION_ID },
    );
    await expect.poll(() => terminalWrites(page), { timeout: 5_000 }).toEqual(['RAW_ONCE\r\n']);
    await expect(page.locator('[data-role]').filter({ hasText: 'RAW_ONCE' })).toHaveCount(0);
  });

  test('default chat starts in chat and terminal choice persists per project session', async ({ page }) => {
    await setupTerminalHarness(page, 'chat');
    await gotoHarnessShell(page);

    const terminal = page.locator('[data-testid="terminal-mode-panel"]');
    await expect(page.locator('[data-testid="chat-composer-input"]')).toBeVisible();
    await expect(terminal).toBeHidden();

    await page.locator('[data-testid="chat-mode-toggle"]').click();
    await expect(terminal).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="terminal-mode-panel"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="chat-composer-input"]')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          ({ projectId, sessionId }) => localStorage.getItem(`pc.terminal-mode.${projectId}.${sessionId}`),
          { projectId: PROJECT_ID, sessionId: SESSION_ID },
        ),
      )
      .toBe('terminal');
  });

  test('workflow builder conversation opens as a wide xterm surface', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupTerminalHarness(page, 'chat', { initialTab: 'workflows' });
    await page.goto('/');
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: '+ New workflow' })).toBeVisible();

    await page.getByRole('button', { name: '+ New workflow' }).click();

    const terminal = page.locator('[data-testid="terminal-mode-panel"]');
    await expect(terminal).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="chat-composer-input"]')).toHaveCount(0);
    await expect(page.locator('.xterm')).toHaveCount(1);
    await expect(page.locator('.react-flow')).toHaveCount(0);
    await expect(page.locator('[data-testid="conversation-header"]')).toHaveCount(1);
    await expect.poll(() => terminalWrites(page), { timeout: 10_000 }).toContain('WORKFLOW_BOOT\r\n');

    const headerBackground = await page
      .locator('[data-testid="conversation-header"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const cardBackground = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--card')
        .trim();
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    expect(headerBackground).toBe(cardBackground);

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const fit = document
              .querySelector('[data-testid="terminal-mode-fit-target"]')
              ?.getBoundingClientRect();
            return {
              width: Math.round(fit?.width ?? 0),
              height: Math.round(fit?.height ?? 0),
            };
          }),
        { timeout: 5_000 },
      )
      .toMatchObject({ width: expect.any(Number), height: expect.any(Number) });

    const fitBox = await page.evaluate(() => {
      const fit = document
        .querySelector('[data-testid="terminal-mode-fit-target"]')
        ?.getBoundingClientRect();
      return {
        width: Math.round(fit?.width ?? 0),
        height: Math.round(fit?.height ?? 0),
      };
    });
    expect(fitBox.width).toBeGreaterThan(1200);
    expect(fitBox.height).toBeGreaterThan(650);
  });

  test('workflow builder terminal is read-only while the session is starting', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupTerminalHarness(page, 'chat', {
      initialTab: 'workflows',
      workflowBuilderState: 'spawning',
    });
    await page.goto('/');
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: '+ New workflow' }).click();

    await expect(page.locator('[data-testid="terminal-mode-panel"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.locator('[data-testid="terminal-mode-fit-target"]').click();
    await page.keyboard.type('abc');
    await page.waitForTimeout(250);

    expect(await terminalInputPayload(page)).toBe('');
  });
});
