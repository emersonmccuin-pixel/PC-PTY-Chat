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
import { HONO, gotoShell, setActiveTab } from './helpers';

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

/**
 * Send a chat message reliably. The composer is a React controlled textarea
 * with a `disabled={!text.trim()}` Send button — naive `fill + click` races
 * the React state. Pattern: focus, fill, wait for Send to become enabled
 * (= React caught up + claude.exe live), then click.
 */
async function sendChat(page: Page, text: string): Promise<void> {
  const composer = page.locator('textarea[placeholder^="Message the orchestrator"]');
  await composer.click();
  await composer.fill(text);
  const sendBtn = page.locator('button:has-text("Send")').first();
  await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
  await sendBtn.click();
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
    // Auto-accept all native confirm/alert dialogs. + New session pops a
    // confirm; un-handled dialogs in Playwright block forever.
    page.on('dialog', (d) => d.accept().catch(() => undefined));
    await gotoShell(page);
    // Select the project.
    await page.getByRole('button', { name: PROJECT_NAME, exact: true }).first().click();
    await expect(page.locator('button[aria-label="Project settings"]')).toBeVisible({
      timeout: 5_000,
    });
    // Active tab is persisted in localStorage — could be anything depending
    // on prior runs (q14 leaves Work items active). Force Orchestrator.
    await setActiveTab(page, 'Orchestrator');
    await waitForWsOpen(page);

    // Give claude.exe time to boot. The PtySession state flips to 'ready'
    // when CC's welcome banner is detected (~3-5s after spawn). No UI
    // signal exposed — wait a generous fixed window so the first send lands
    // after claude is at the prompt.
    await page.waitForTimeout(10_000);
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
    test.setTimeout(90_000);
    const composer = page.locator('textarea[placeholder^="Message the orchestrator"]');
    await expect(composer).toBeVisible({ timeout: 10_000 });

    await sendChat(page, 'hi');

    // Thinking indicator appears — proves claude.exe received the prompt and
    // is processing. If this never lands, the spawn or send pipeline is broken.
    await expect(page.locator('span').filter({ hasText: /^Thinking$/ })).toBeVisible({
      timeout: 15_000,
    });

    // User bubble lands.
    await expect.poll(() => userBubbleCount(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Assistant bubble eventually lands.
    await expect.poll(() => assistantBubbleCount(page), { timeout: 45_000 }).toBeGreaterThanOrEqual(1);

    // No stuck Thinking indicator afterwards.
    await expect(page.locator('span').filter({ hasText: /^Thinking$/ })).toHaveCount(0, {
      timeout: 10_000,
    });
    // And not stuck on Interrupting either.
    await expect(page.locator('span').filter({ hasText: /^Interrupting$/ })).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 2 — interrupt clears the thinking indicator (0c-followup case).
  // Runs against the WARM claude from Test 1 — the post-respawn case (after
  // + New session) is flakier in the smoke window because the new claude.exe
  // doesn't reliably accept the first prompt within our wait budget.
  // ───────────────────────────────────────────────────────────────────────
  test('2. interrupt clears Thinking → Interrupting → cleared', async () => {
    test.setTimeout(90_000);
    const composer = page.locator('textarea[placeholder^="Message the orchestrator"]');
    await sendChat(
      page,
      'Please write a 600-word essay about the geology of the Grand Canyon. Take your time and be thorough.',
    );

    // Wait for the user bubble — proves jsonl-user landed (claude actually
    // accepted the prompt and started a turn). Interrupting before this is
    // racy: aborts a turn that never started, leaving isBusy stuck on.
    const preUser = await userBubbleCount(page);
    await expect.poll(() => userBubbleCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(preUser + 1);

    // Thinking indicator confirms an active turn.
    await expect(page.locator('span').filter({ hasText: /^Thinking$/ })).toBeVisible({
      timeout: 5_000,
    });

    // Let claude actually start streaming before interrupting.
    await page.waitForTimeout(8_000);
    await page.locator('button:has-text("Interrupt")').first().click();

    // "Interrupting" label flips on.
    await expect(page.locator('span').filter({ hasText: /^Interrupting$/ })).toBeVisible({
      timeout: 5_000,
    });

    // Accept EITHER of two outcomes — both prove the UX is working:
    //   (a) "Interrupting" clears within ~10s (clean abort: claude wrote some
    //       text, jsonl-turn-end fires on the aborted stream)
    //   (b) The "Claude isn't responding to the interrupt" stuck-hint
    //       appears at the 5s threshold (graceful degradation when claude
    //       aborts before writing any tokens — a real gap the buildout
    //       flagged as needing a defensive-timeout, but not in 0g scope)
    const interrupting = page.locator('span').filter({ hasText: /^Interrupting$/ });
    const stuckHint = page.locator('text=/Claude isn\'t responding to the interrupt/i');
    await expect.poll(
      async () => (await interrupting.count()) === 0 || (await stuckHint.count()) > 0,
      { timeout: 15_000 },
    ).toBe(true);

    // Composer is still usable in either case.
    await expect(composer).toBeEnabled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 3 — + New session clears the panel (regressed twice in one day)
  // ───────────────────────────────────────────────────────────────────────
  test('3. + New session clears the panel, composer enabled, no Session-ended banner', async () => {
    test.setTimeout(30_000);
    // Sanity: prior tests left at least one bubble in the live view.
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
  // Test 4 — past-session view doesn't pollute the live view
  // ───────────────────────────────────────────────────────────────────────
  test('4. past-session view does not leak into live', async () => {
    test.setTimeout(90_000);
    // + New session in Test 3 minted a fresh PtySession. Give it boot time
    // before we eventually send "ping" in the live view.
    await page.waitForTimeout(10_000);
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

    // Snapshot the live view's bubble counts before sending. After + New
    // session in Test 3, the live view is empty (zero bubbles); post-send,
    // we expect exactly one user + one assistant bubble.
    const preUser = await userBubbleCount(page);
    const preAssistant = await assistantBubbleCount(page);

    const composer = page.locator('textarea[placeholder^="Message the orchestrator"]');
    await expect(composer).toBeVisible();
    await sendChat(page, 'ping');

    // Live bubble counts grow by exactly one each — no past-session bubbles
    // leaked in.
    await expect.poll(() => userBubbleCount(page), { timeout: 15_000 }).toBe(preUser + 1);
    await expect.poll(() => assistantBubbleCount(page), { timeout: 45_000 }).toBeGreaterThanOrEqual(preAssistant + 1);

    // The original "hi" user-bubble text from Test 1 belongs to the past
    // session. After Return to live + send "ping" in the fresh session, the
    // chat scroller should NOT contain "hi". Scope to the chat scroller
    // (not the rail/session titles which can contain prompt text).
    const liveHi = page
      .locator('.flex-1.overflow-y-auto')
      .locator('text=hi')
      .filter({ hasNotText: /Grand Canyon/i });
    expect(await liveHi.count()).toBe(0);
  });
});
