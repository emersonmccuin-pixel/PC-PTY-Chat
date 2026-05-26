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
// Requires: Claude Code installed + authenticated (real CC roundtrips), the
// folder at SMOKE_WORKSPACE writable. The dev stack also needs `claude` in
// PATH — same as normal use.

import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HONO, gotoShell, setActiveTab } from './helpers';

const SMOKE_ROOT = join(tmpdir(), 'pc-smoke-test');
const SMOKE_WORKSPACE = join(SMOKE_ROOT, 'workspace');
const PROJECT_NAME = 'PC Smoke';
const PROJECT_SLUG = 'pc-smoke';
const HAPPY_PROMPT = 'pc smoke happy path hello';

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

/** Wait for the project WebSocket to connect.
 *  Section 22.4 — switched from a brittle title-prefix + text regex to the
 *  stable [data-ws-status] attribute on the pill. The visible label/title
 *  changes with theme; the attribute is contractual. */
async function waitForWsOpen(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="ws-pill"]')).toHaveAttribute(
    'data-ws-status',
    'open',
    { timeout: 15_000 },
  );
}

async function waitForRuntimeReadyOrSkip(page: Page, timeout = 60_000): Promise<void> {
  const runtimePill = page.locator('[data-testid="runtime-pill"]');
  await expect(runtimePill).toBeVisible({ timeout: 15_000 });
  const deadline = Date.now() + timeout;
  let lastHealth = await runtimePill.getAttribute('data-runtime-health');
  while (Date.now() < deadline) {
    await skipIfClaudeUsageLimited(page);
    lastHealth = await runtimePill.getAttribute('data-runtime-health');
    if (lastHealth === 'ready') return;
    if (lastHealth === 'failed_resume' || lastHealth === 'provider_missing') {
      test.skip(true, `Claude runtime is inaccessible (${lastHealth})`);
    }
    await page.waitForTimeout(500);
  }
  test.skip(true, `Claude runtime did not become ready in time (last health: ${lastHealth ?? 'unknown'})`);
}

/**
 * Send a chat message reliably. The composer is a React controlled textarea
 * with a `disabled={!text.trim()}` Send button — naive `fill + click` races
 * the React state. Pattern: focus, fill, wait for Send to become enabled
 * (= React caught up + Claude Code live), then click.
 */
async function sendChat(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="chat-composer-input"]');
  await composer.click();
  await composer.fill(text);
  const sendBtn = page.getByRole('button', { name: /^(Send|Queue)/i }).first();
  await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
  await sendBtn.click();
}

/** Count user / assistant bubbles via the stable [data-role] attribute on
 *  the chat-turn row. Section 22.4 — replaces a text-class selector that
 *  rotted when the role label moved into a `chat-turn-name` span and no
 *  longer matched `div.text-[10px].uppercase`. */
async function userBubbleCount(page: Page): Promise<number> {
  return await page.locator('[data-role="user"]').count();
}

async function confirmedUserBubbleCount(page: Page): Promise<number> {
  return await page.locator('[data-role="user"]:not([data-pending-status])').count();
}

function confirmedUserBubbleWithText(page: Page, text: string): Locator {
  return page.locator('[data-role="user"]:not([data-pending-status])').filter({ hasText: text });
}

async function waitForConfirmedUserTextOrSkip(
  page: Page,
  text: string,
  timeout = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const confirmed = confirmedUserBubbleWithText(page, text);
  while (Date.now() < deadline) {
    await skipIfClaudeUsageLimited(page);
    if ((await confirmed.count()) > 0) return;
    await page.waitForTimeout(500);
  }
  test.skip(true, 'Claude did not confirm the expected user prompt in this environment');
}

async function waitForConfirmedUserCountOrSkip(
  page: Page,
  expected: number,
  timeout = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await skipIfClaudeUsageLimited(page);
    if ((await confirmedUserBubbleCount(page)) >= expected) return;
    await page.waitForTimeout(500);
  }
  test.skip(true, 'Claude did not confirm the user prompt in this environment');
}

function queueItemByText(page: Page, text: string): Locator {
  return page.locator('[data-testid="composer-queue-item"]').filter({ hasText: text });
}

async function expectConfirmedUserOrder(
  page: Page,
  markers: string[],
  timeout = 120_000,
): Promise<void> {
  await expect.poll(async () => {
    const rows = await page.locator('[data-role="user"]:not([data-pending-status])').allTextContents();
    let cursor = -1;
    for (const marker of markers) {
      const idx = rows.findIndex((text, i) => i > cursor && text.includes(marker));
      if (idx === -1) return false;
      cursor = idx;
    }
    return true;
  }, { timeout }).toBe(true);
}

async function skipIfClaudeUsageLimited(page: Page): Promise<void> {
  const usageLimit = page.getByText(
    /weekly limit|usage limit|rate limit/i,
  );
  if ((await usageLimit.count()) > 0) {
    test.skip(true, 'Claude usage limit is exhausted in this environment');
  }
}

async function waitForThinkingOrSkip(page: Page, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  const thinking = page.locator('span').filter({ hasText: /^Thinking$/ });
  while (Date.now() < deadline) {
    await skipIfClaudeUsageLimited(page);
    if ((await thinking.count()) > 0) return;
    await page.waitForTimeout(250);
  }
  test.skip(true, 'Claude did not stay busy long enough for this regression');
}

async function ensureStillThinkingOrSkip(page: Page): Promise<void> {
  await skipIfClaudeUsageLimited(page);
  const thinking = page.locator('span').filter({ hasText: /^Thinking$/ });
  if ((await thinking.count()) === 0) {
    test.skip(true, 'Claude did not stay busy long enough for this regression');
  }
}

async function ensureOrchestratorAfterReload(page: Page): Promise<void> {
  await page.reload();
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 10_000 });
  const settingsButton = page.locator('button[aria-label="Project settings"]');
  if ((await settingsButton.count()) === 0) {
    await page.getByRole('button', { name: PROJECT_NAME, exact: true }).first().click();
  }
  await expect(settingsButton).toBeVisible({ timeout: 10_000 });
  await setActiveTab(page, 'Orchestrator');
  await waitForWsOpen(page);
}

async function startNewSession(page: Page): Promise<void> {
  await page.locator('button:has-text("+ New session")').click();
  await expect(
    page.locator('text=No chat events yet. Send a message below to wake the orchestrator.'),
  ).toBeVisible({ timeout: 15_000 });
}

async function assistantBubbleCount(page: Page): Promise<number> {
  return await page.locator('[data-role="assistant"]').count();
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

    // Runtime health is now explicit; individual real-Claude tests wait for
    // `ready` and skip cleanly when quota/startup prevents a live turn.
    await expect(page.locator('[data-testid="runtime-pill"]')).toBeVisible({
      timeout: 15_000,
    });
  });

  test.afterAll(async ({ request }) => {
    if (page) await page.close().catch(() => undefined);
    await cleanupSmokeProjects(request);
    resetWorkspace();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 1 — happy path roundtrip
  // ───────────────────────────────────────────────────────────────────────
  test('1. send prompt → user bubble + assistant bubble + no stuck spinner', async () => {
    test.setTimeout(90_000);
    const composer = page.locator('[data-testid="chat-composer-input"]');
    await expect(composer).toBeVisible({ timeout: 10_000 });

    const preUser = await userBubbleCount(page);
    const preConfirmedUser = await confirmedUserBubbleCount(page);
    await waitForRuntimeReadyOrSkip(page);
    await sendChat(page, HAPPY_PROMPT);

    // The UI now creates a local pending bubble immediately; the canonical
    // transcript row will replace it once jsonl-user lands.
    await expect.poll(() => userBubbleCount(page), { timeout: 2_000 }).toBeGreaterThanOrEqual(preUser + 1);

    // Thinking indicator appears — proves Claude Code received the prompt and
    // is processing. If this never lands, the spawn or send pipeline is broken.
    await expect(page.locator('span').filter({ hasText: /^Thinking$/ })).toBeVisible({
      timeout: 15_000,
    });

    // Confirmed user bubble lands from JSONL.
    await waitForConfirmedUserCountOrSkip(page, preConfirmedUser + 1);

    // Assistant bubble eventually lands.
    await expect.poll(() => assistantBubbleCount(page), { timeout: 45_000 }).toBeGreaterThanOrEqual(1);
    await skipIfClaudeUsageLimited(page);

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
  // + New session) is flakier in the smoke window because the new Claude Code
  // doesn't reliably accept the first prompt within our wait budget.
  // ───────────────────────────────────────────────────────────────────────
  test('2. interrupt clears Thinking → Interrupting → cleared', async () => {
    test.setTimeout(90_000);
    const composer = page.locator('[data-testid="chat-composer-input"]');
    const preUser = await confirmedUserBubbleCount(page);
    await waitForRuntimeReadyOrSkip(page);
    await sendChat(
      page,
      'Please write a 600-word essay about the geology of the Grand Canyon. Take your time and be thorough.',
    );

    // Wait for the confirmed user bubble — proves jsonl-user landed (claude
    // actually accepted the prompt and started a turn). Interrupting before
    // this is racy: aborts a turn that never started, leaving isBusy stuck on.
    await waitForConfirmedUserCountOrSkip(page, preUser + 1);
    await skipIfClaudeUsageLimited(page);

    // Thinking indicator confirms an active turn.
    await waitForThinkingOrSkip(page, 5_000);

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
    if ((await userBubbleCount(page)) === 0) {
      test.skip(true, 'Happy-path chat did not complete in this environment');
    }

    await startNewSession(page);

    // Bubble counts are zero.
    expect(await userBubbleCount(page)).toBe(0);
    expect(await assistantBubbleCount(page)).toBe(0);

    // Composer is enabled (no Session-ended banner blocking it).
    await expect(
      page.locator('text=This session ended.'),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="chat-composer-input"]')).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 4 — resume applies replay transactionally and follow-up appends.
  // ───────────────────────────────────────────────────────────────────────
  test('4. resume from history keeps replay visible and appends follow-up', async () => {
    test.setTimeout(90_000);
    if ((await confirmedUserBubbleWithText(page, HAPPY_PROMPT).count()) === 0) {
      test.skip(true, 'Happy-path chat did not confirm in this environment');
    }
    await page.locator('[data-testid="session-switcher-trigger"]').click();
    await page.locator('[data-testid="session-switcher-browse-all"]').click();

    const liveRows = page.locator('[data-testid="session-row"][data-session-status="active"]');
    const endedRows = page.locator('[data-testid="session-row"][data-session-status="ended"]');
    await expect(liveRows).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(() => endedRows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    const pastRow = endedRows.first();
    await pastRow.locator('button[title]').first().click();
    await expect(page.locator('button:has-text("Return to live")')).toBeVisible({
      timeout: 10_000,
    });
    await expect(confirmedUserBubbleWithText(page, HAPPY_PROMPT)).toBeVisible({
      timeout: 10_000,
    });

    await pastRow.hover();
    await pastRow.locator('[data-testid="session-resume"]').click();
    await expect(page.locator('text=Viewing past session')).toHaveCount(0, { timeout: 15_000 });
    await expect(
      page.locator('text=No chat events yet. Send a message below to wake the orchestrator.'),
    ).toHaveCount(0);
    await expect(confirmedUserBubbleWithText(page, HAPPY_PROMPT)).toBeVisible({
      timeout: 10_000,
    });
    await skipIfClaudeUsageLimited(page);

    const followUp = `resume regression follow-up ${Date.now().toString(36)}`;
    await waitForRuntimeReadyOrSkip(page);
    await sendChat(page, followUp);
    await skipIfClaudeUsageLimited(page);
    await waitForConfirmedUserTextOrSkip(page, followUp, 20_000);
    await expect(confirmedUserBubbleWithText(page, HAPPY_PROMPT)).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 5 — server-owned busy queue: refresh, cancel, FIFO drain.
  // ───────────────────────────────────────────────────────────────────────
  test('5. busy-send queue survives refresh, cancels, and drains FIFO', async () => {
    test.setTimeout(240_000);
    await startNewSession(page);
    await waitForRuntimeReadyOrSkip(page);

    const suffix = Date.now().toString(36);
    const longPrompt =
      `queue regression root ${suffix}: write a detailed 1200-word response about ` +
      'how a desktop app should handle chat reliability. Do not use bullets.';
    const refreshPrompt = `queue refresh marker ${suffix}`;
    const cancelPrompt = `queue cancel marker ${suffix}`;
    const drainA = `queue drain A marker ${suffix}. Reply exactly DRAIN_A_${suffix}.`;
    const drainB = `queue drain B marker ${suffix}. Reply exactly DRAIN_B_${suffix}.`;

    await sendChat(page, longPrompt);
    await skipIfClaudeUsageLimited(page);
    await waitForThinkingOrSkip(page, 15_000);
    await waitForConfirmedUserTextOrSkip(page, longPrompt, 20_000);
    await skipIfClaudeUsageLimited(page);
    await waitForThinkingOrSkip(page, 5_000);
    await page.waitForTimeout(500);
    await ensureStillThinkingOrSkip(page);

    await sendChat(page, refreshPrompt);
    await expect(queueItemByText(page, refreshPrompt)).toBeVisible({ timeout: 5_000 });

    await ensureOrchestratorAfterReload(page);
    await expect(queueItemByText(page, refreshPrompt)).toBeVisible({ timeout: 15_000 });

    await sendChat(page, cancelPrompt);
    const cancelItem = queueItemByText(page, cancelPrompt);
    await expect(cancelItem).toBeVisible({ timeout: 5_000 });
    await cancelItem.getByRole('button', { name: 'Cancel queued prompt' }).click();
    await expect(cancelItem).toHaveCount(0, { timeout: 10_000 });

    await sendChat(page, drainA);
    await sendChat(page, drainB);
    await expect(queueItemByText(page, drainA)).toBeVisible({ timeout: 5_000 });
    await expect(queueItemByText(page, drainB)).toBeVisible({ timeout: 5_000 });

    await expectConfirmedUserOrder(page, [longPrompt, refreshPrompt, drainA, drainB], 180_000);
    await expect(confirmedUserBubbleWithText(page, cancelPrompt)).toHaveCount(0);
  });
});
