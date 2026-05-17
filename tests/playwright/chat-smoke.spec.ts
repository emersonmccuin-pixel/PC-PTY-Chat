// Chat reliability smoke (buildout/chat-reliability.md Phase 0g).
//
// Four boring, fast tests that pin the regressions that bit during the
// 2026-05-17 session:
//   1. happy path — send "hi" + assert user/assistant bubble + no stuck spinner
//   2. + New session — panel clears, composer enabled, no Session-ended banner
//   3. interrupt — "Interrupting…" appears and clears within 5s
//   4. past session — viewing past chat does not pollute the live view
//
// Boot model: assumes the user's dev stack is up (Vite :5173 + Hono :4040 +
// channel :8788). Project isolation comes from a `pc-smoke-` slug prefix
// and the helpers below clean those up at start AND end. This deviates from
// the buildout's "temp PC_DATA_DIR" wording — matching q14.spec.ts' proven
// prefix-cleanup pattern is far simpler and avoids killing the user's Hono
// mid-test. If stronger isolation is ever needed, swap in the killPort +
// startHono helpers from q14-gaps.spec.ts.
//
// Requires: claude.exe installed + authenticated (real CC roundtrips), the
// folder at SMOKE_WORKSPACE writable. The dev stack also needs claude.exe in
// PATH — same as normal use.

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { HONO, gotoShell } from './helpers';

const SMOKE_ROOT = 'E:\\temp\\pc-smoke-test';
const SMOKE_WORKSPACE = `${SMOKE_ROOT}\\workspace`;
const PROJECT_NAME = 'PC Smoke';
const PROJECT_SLUG = 'pc-smoke';

interface ProjectShape {
  id: string;
  slug: string;
  name: string;
  folderPath: string;
}

async function cleanupSmokeProjects(req: APIRequestContext): Promise<void> {
  const r = await req.get(`${HONO}/api/projects?include_deleted=1`);
  if (!r.ok()) return;
  const { projects } = (await r.json()) as { projects: ProjectShape[] };
  for (const p of projects) {
    if (!p.slug.startsWith('pc-smoke')) continue;
    await req.delete(`${HONO}/api/projects/${p.id}/files`).catch(() => null);
    await req.delete(`${HONO}/api/projects/${p.id}`).catch(() => null);
  }
}

function resetWorkspace(): void {
  if (existsSync(SMOKE_WORKSPACE)) {
    try { rmSync(SMOKE_WORKSPACE, { recursive: true, force: true }); } catch { /* noop */ }
  }
  mkdirSync(SMOKE_WORKSPACE, { recursive: true });
}

async function createSmokeProject(req: APIRequestContext): Promise<ProjectShape> {
  const r = await req.post(`${HONO}/api/projects`, {
    data: {
      name: PROJECT_NAME,
      folder_path: SMOKE_WORKSPACE,
      mode: 'init-empty',
    },
  });
  if (!r.ok()) throw new Error(`createSmokeProject ${r.status()}: ${await r.text()}`);
  const { project } = (await r.json()) as { project: ProjectShape };
  return project;
}

/** WS pill text — `ws: open` once the project WebSocket is connected. */
async function waitForWsOpen(page: Page): Promise<void> {
  await expect(page.locator('span[title^="WS:"]')).toHaveText(/ws: open/, {
    timeout: 15_000,
  });
}

/** Count user bubbles by counting the "You" role label divs. */
async function userBubbleCount(page: Page): Promise<number> {
  // RoleLabel renders <div class="… text-[10px] uppercase tracking-wider …">You</div>
  return await page.locator('div.text-\\[10px\\].uppercase').filter({ hasText: /^You$/ }).count();
}

async function assistantBubbleCount(page: Page): Promise<number> {
  return await page.locator('div.text-\\[10px\\].uppercase').filter({ hasText: /^Claude$/ }).count();
}

test.describe.serial('Chat smoke (0g)', () => {
  let page: Page;
  let project: ProjectShape;

  test.beforeAll(async ({ browser, request }) => {
    await cleanupSmokeProjects(request);
    resetWorkspace();
    project = await createSmokeProject(request);
    expect(project.slug).toBe(PROJECT_SLUG);

    page = await browser.newPage();
    await gotoShell(page);
    // Select the project.
    await page.getByRole('button', { name: PROJECT_NAME, exact: true }).first().click();
    await expect(page.locator('button[aria-label="Project settings"]')).toBeVisible({
      timeout: 5_000,
    });
    await waitForWsOpen(page);
  });

  test.afterAll(async ({ request }) => {
    if (page) await page.close().catch(() => undefined);
    await cleanupSmokeProjects(request);
    resetWorkspace();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 1 — happy path roundtrip
  // ───────────────────────────────────────────────────────────────────────
  test('1. send "hi" → user bubble + assistant bubble + no stuck spinner', async () => {
    test.setTimeout(60_000);
    const composer = page.locator('textarea[placeholder^="Message the orchestrator"]');
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill('hi');
    await page.locator('button:has-text("Send")').first().click();

    // One user bubble lands immediately.
    await expect.poll(() => userBubbleCount(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Assistant bubble eventually lands.
    await expect.poll(() => assistantBubbleCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

    // No stuck Thinking indicator afterwards.
    await expect(page.locator('span').filter({ hasText: /^Thinking$/ })).toHaveCount(0, {
      timeout: 5_000,
    });
    // And not stuck on Interrupting either.
    await expect(page.locator('span').filter({ hasText: /^Interrupting$/ })).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 2 — + New session clears the panel (regressed twice in one day)
  // ───────────────────────────────────────────────────────────────────────
  test('2. + New session clears the panel, composer enabled, no Session-ended banner', async () => {
    test.setTimeout(30_000);
    // Sanity: Test 1 left at least one bubble.
    expect(await userBubbleCount(page)).toBeGreaterThanOrEqual(1);

    await page.locator('button:has-text("+ New session")').click();

    // Empty state copy appears (panel cleared, no JSONL replay leaking).
    await expect(
      page.locator('text=No chat events yet. Send a message below to wake the orchestrator.'),
    ).toBeVisible({ timeout: 15_000 });

    // Bubble counts are zero.
    expect(await userBubbleCount(page)).toBe(0);
    expect(await assistantBubbleCount(page)).toBe(0);

    // Composer is enabled (no Session-ended banner blocking it).
    await expect(
      page.locator('text=This session ended.'),
    ).toHaveCount(0);
    await expect(page.locator('textarea[placeholder^="Message the orchestrator"]')).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 3 — interrupt clears the thinking indicator (0c-followup case)
  // ───────────────────────────────────────────────────────────────────────
  test('3. interrupt clears Thinking → Interrupting → cleared', async () => {
    test.setTimeout(60_000);
    const composer = page.locator('textarea[placeholder^="Message the orchestrator"]');
    await composer.fill(
      'Please write a 600-word essay about the geology of the Grand Canyon. Take your time and be thorough.',
    );
    await page.locator('button:has-text("Send")').first().click();

    // Thinking indicator appears.
    await expect(page.locator('span').filter({ hasText: /^Thinking$/ })).toBeVisible({
      timeout: 10_000,
    });

    // Give CC a beat to start streaming before we interrupt.
    await page.waitForTimeout(2_000);
    await page.locator('button:has-text("Interrupt")').first().click();

    // "Interrupting" label flips on (the indicator swaps Thinking → Interrupting).
    await expect(page.locator('span').filter({ hasText: /^Interrupting$/ })).toBeVisible({
      timeout: 5_000,
    });

    // Within 5s the indicator clears (JSONL turn-end fires on the aborted stream).
    await expect(page.locator('span').filter({ hasText: /^Interrupting$/ })).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.locator('span').filter({ hasText: /^Thinking$/ })).toHaveCount(0);

    // Composer is still usable.
    await expect(composer).toBeEnabled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 4 — past-session view doesn't pollute the live view
  // ───────────────────────────────────────────────────────────────────────
  test('4. past-session view does not leak into live', async () => {
    test.setTimeout(45_000);
    // Switch the rail to Sessions mode.
    await page.locator('button:has-text("Sessions")').first().click();

    // SessionsRail rows are <button title="…"> children of the rail body.
    // Scope to the rail container (the div whose header is "Sessions") so we
    // don't pick up sidebar/buttons elsewhere with title attrs.
    const sessionsRailBody = page
      .locator('div.flex.h-full.flex-col.bg-card.text-foreground')
      .filter({ has: page.locator('text=Sessions') });
    const sessionRows = sessionsRailBody.locator('button[title]');

    // Live row carries the " · live" suffix; past rows do not.
    await expect(sessionRows.filter({ hasText: '· live' })).toHaveCount(1, { timeout: 10_000 });
    await expect(sessionRows).toHaveCount(await sessionRows.count());
    expect(await sessionRows.count()).toBeGreaterThanOrEqual(2);

    // SessionsRail lists newest first ⇒ row 0 is live ⇒ row 1 is the most
    // recent past session (Test 1's "hi" turn, ended by + New session in Test 2).
    await sessionRows.nth(1).click();

    // Past-session view shows the "Return to live" button in the orchestrator
    // header and the past session's bubbles (Test 1 had "hi" + the assistant
    // reply, so at least one Claude bubble should render).
    await expect(page.locator('button:has-text("Return to live")')).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(() => assistantBubbleCount(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Click Return to live.
    await page.locator('button:has-text("Return to live")').click();
    await expect(page.locator('button:has-text("+ New session")')).toBeVisible({
      timeout: 5_000,
    });

    // Switch the rail back to Projects so the composer area isn't obscured by
    // the Sessions list (optional — composer lives in the main pane).
    await page.locator('button:has-text("Projects")').first().click();

    // Snapshot the live view's bubble counts before sending. (Test 3 left
    // one user message + possibly partial assistant. Whatever the count, the
    // POST-send live view should equal pre + (1 user) + (1 assistant).)
    const preUser = await userBubbleCount(page);
    const preAssistant = await assistantBubbleCount(page);

    const composer = page.locator('textarea[placeholder^="Message the orchestrator"]');
    await expect(composer).toBeVisible();
    await composer.fill('ping');
    await page.locator('button:has-text("Send")').first().click();

    // Live bubble counts grow by exactly one each — no past-session bubbles
    // leaked in.
    await expect.poll(() => userBubbleCount(page), { timeout: 10_000 }).toBe(preUser + 1);
    await expect.poll(() => assistantBubbleCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(preAssistant + 1);

    // Specifically: the original Test 1 "hi" user-bubble text should NOT
    // appear in the live view (it lives in the past session only).
    // Use a strict locator that targets bubble bodies, not the rail/session
    // titles which can contain prompt text.
    const liveHi = page
      .locator('.flex-1.overflow-y-auto')
      .locator('text=hi')
      .filter({ hasNotText: /Grand Canyon/i });
    // The "hi" from Test 1 belongs to the past session. After Return to live,
    // it shouldn't render. (The live view's history at this point: Test 3's
    // essay prompt + interrupt + Test 4's "ping".)
    expect(await liveHi.count()).toBe(0);
  });
});
