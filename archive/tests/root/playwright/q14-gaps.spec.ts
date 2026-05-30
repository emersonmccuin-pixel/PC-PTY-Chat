// Q14 coverage gaps: folder-picker real-UI flow (B.3 / C.3 / D) and WS
// reconnect + dedup (Section L). These were skipped by the prior pass.
//
// As of D81 (2026-05-19) the fs-browse server has no allowlist gate, so the
// picker can drill into any absolute path the OS exposes — no env-var prereq.

import { test, expect, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY,
  FIXTURE_ROOT,
  HONO,
  WITH_FILES,
  cleanupQ14,
  findProjectBySlug,
  getSettings,
  gotoShell,
  listProjects,
  patchSettings,
  setProjectsFolder,
} from './helpers';

const REPO_ROOT = process.cwd();

let savedProjectsFolder = '';

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle: clean fixtures + DB at start, restore at end.
// ─────────────────────────────────────────────────────────────────────────────
test.beforeAll(async ({ request }) => {
  const s = await getSettings(request);
  savedProjectsFolder = s.projectsFolder;
  await cleanupQ14(request);
  resetFixtures();
  await setProjectsFolder(request, FIXTURE_ROOT);
  // Make sure activity panel is open + All=off so Section L assertions are
  // stable.
  await patchSettings(request, {
    activityPanel: { open: true, showAllProjects: false },
  });
});

test.afterAll(async ({ request }) => {
  // Best-effort: if the server is reachable, tidy up. Section L's last test
  // leaves Hono running, but a mid-suite failure could leave the server
  // killed — in that case the cleanup is skipped silently.
  try {
    await cleanupQ14(request);
    if (savedProjectsFolder) {
      await patchSettings(request, { projectsFolder: savedProjectsFolder });
    }
  } catch {
    /* server may be down — outer driver restarts it */
  }
  resetFixtures();
});

function resetFixtures(): void {
  if (existsSync(EMPTY)) {
    try { rmSync(EMPTY, { recursive: true, force: true }); } catch { /* noop */ }
  }
  mkdirSync(EMPTY, { recursive: true });
  if (existsSync(WITH_FILES)) {
    try { rmSync(WITH_FILES, { recursive: true, force: true }); } catch { /* noop */ }
  }
  mkdirSync(WITH_FILES, { recursive: true });
  writeFileSync(join(WITH_FILES, 'README.md'), '# fixture\n');
  writeFileSync(join(WITH_FILES, 'notes.txt'), 'fixture notes\n');
  mkdirSync(join(WITH_FILES, 'src'), { recursive: true });
  writeFileSync(join(WITH_FILES, 'src', 'index.js'), 'console.log("fixture")\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — folder picker UI flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the Create Project modal, fill the name, then drill the picker to the
 * specified subfolder name under projectsFolder and select it.
 *
 * Drill = single click on the entry row (loads its children + sets
 * `view.path` to that folder). Select = click the "Select this folder"
 * footer button (calls `onSelect(view.path)`, which closes the picker and
 * triggers the probe in the parent modal). Double-click as a single
 * operation is unreliable because the first click navigates and the second
 * click hits a different rendered button.
 */
async function openCreateAndPick(
  page: Page,
  projectName: string,
  subfolderName: string,
): Promise<void> {
  await page.locator('text=+ New project').click();
  await expect(page.locator('text=Create project')).toBeVisible();
  await page.locator('input[placeholder="My project"]').fill(projectName);
  await page.locator('button:has-text("Browse…")').click();
  await expect(page.locator('text=Choose folder')).toBeVisible();
  // Picker starts at projectsFolder. The subfolder
  // rows should be listed at this level. If the picker remembers a deeper
  // last-browsed dir, walk back up via ↑ until we find the row.
  const entryRow = page
    .locator('ul li button')
    .filter({ hasText: subfolderName })
    .first();
  // Up to 5 ↑ presses to find the row.
  for (let i = 0; i < 6; i++) {
    if (await entryRow.isVisible().catch(() => false)) break;
    const up = page.locator('button[title="Parent directory"]');
    if (!(await up.isEnabled().catch(() => false))) break;
    await up.click();
    await page.waitForTimeout(150);
  }
  await expect(entryRow).toBeVisible({ timeout: 5_000 });
  // Drill into the subfolder.
  await entryRow.click();
  // Confirm the picker now lists the subfolder's path (top-of-picker code).
  await expect(
    page.locator('code').filter({ hasText: subfolderName }).first(),
  ).toBeVisible({ timeout: 5_000 });
  // Now select it via the footer button.
  await page.locator('button:has-text("Select this folder")').click();
  // Picker closes, modal probe runs.
  await expect(page.locator('text=Choose folder')).toBeHidden({ timeout: 5_000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Gap 1 — Folder picker real-UI flow (B.3 / C.3 / D)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('B.3 (real UI) — empty-folder via picker', () => {
  test('drives FolderBrowserModal end-to-end and creates Project A', async ({
    page,
    request,
  }) => {
    await gotoShell(page);
    await openCreateAndPick(page, 'Q14 Project A', 'empty-folder');
    // Probe preview should read the empty-folder string.
    await expect(
      page.locator(
        'text=Empty folder — will git init here and commit the scaffold.',
      ),
    ).toBeVisible({ timeout: 5_000 });
    const create = page.locator('button:has-text("Create")');
    await expect(create).toBeEnabled();
    await create.click();
    // Project lands in the rail.
    await expect(
      page.getByRole('button', { name: 'Q14 Project A', exact: true }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Sanity: API confirms + scaffold committed.
    const p = await findProjectBySlug(request, 'q14-project-a');
    expect(p).not.toBeNull();
    expect(p!.folderPath).toBe(EMPTY);
    const log = execSync('git log --oneline', { cwd: EMPTY }).toString().trim();
    expect(log.split('\n').length).toBe(1);
    expect(log).toMatch(/Initial commit/);
  });
});

test.describe('C.3 (real UI) — folder-with-files via picker', () => {
  test('drives picker for in-place init and creates Project C', async ({
    page,
    request,
  }) => {
    await gotoShell(page);
    await openCreateAndPick(page, 'Q14 Project C', 'folder-with-files');
    // Probe preview text — the count varies if cleanup didn't run, so
    // accept any digit count.
    await expect(
      page.locator(
        'text=/\\d+ existing entr(y|ies), no \\.git/',
      ).first(),
    ).toBeVisible({ timeout: 5_000 });
    const create = page.locator('button:has-text("Create")');
    await expect(create).toBeEnabled();
    await create.click();
    await expect(
      page.getByRole('button', { name: 'Q14 Project C', exact: true }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Two commits on disk: Initial import + Add Caisson scaffold.
    const log = execSync('git log --oneline', { cwd: WITH_FILES }).toString().trim();
    const commits = log.split('\n');
    expect(commits.length).toBe(2);
    expect(commits[0]).toMatch(/Add Caisson scaffold/);
    expect(commits[1]).toMatch(/Initial import/);
  });
});

test.describe('D (real UI) — re-init refused via picker', () => {
  test('picker on already-git folder shows refusal and Create stays disabled', async ({
    page,
  }) => {
    await gotoShell(page);
    await page.locator('text=+ New project').click();
    await expect(page.locator('text=Create project')).toBeVisible();
    await page.locator('input[placeholder="My project"]').fill('Q14 Reject');
    await page.locator('button:has-text("Browse…")').click();
    await expect(page.locator('text=Choose folder')).toBeVisible();
    // folder-with-files now has .git (Project C created above). Drill into it.
    const row = page
      .locator('ul li button')
      .filter({ hasText: 'folder-with-files' })
      .first();
    for (let i = 0; i < 6; i++) {
      if (await row.isVisible().catch(() => false)) break;
      const up = page.locator('button[title="Parent directory"]');
      if (!(await up.isEnabled().catch(() => false))) break;
      await up.click();
      await page.waitForTimeout(150);
    }
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click();
    await expect(
      page.locator('code').filter({ hasText: 'folder-with-files' }).first(),
    ).toBeVisible({ timeout: 5_000 });
    await page.locator('button:has-text("Select this folder")').click();
    await expect(page.locator('text=Choose folder')).toBeHidden({ timeout: 5_000 });
    // Probe rejects with the git-repo message.
    await expect(
      page.locator('text=Already a git repo — cannot create a project here.'),
    ).toBeVisible({ timeout: 5_000 });
    // Create button stays disabled.
    const create = page.locator('button:has-text("Create")');
    await expect(create).toBeDisabled();
    // Tidy: cancel the modal.
    await page.locator('button:has-text("Cancel")').click();
    await expect(page.locator('text=Create project')).toBeHidden({ timeout: 5_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 2 — Section L (WS reconnect + dedup)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the ActivityPanel "N events" counter. Falls back to counting
 * `<li>` rows under the panel if the counter span isn't found.
 */
async function readEventCount(page: Page): Promise<number> {
  const countSpan = page.locator('span').filter({ hasText: /^\d+ events$/ }).first();
  const visible = await countSpan.isVisible().catch(() => false);
  if (visible) {
    const txt = (await countSpan.innerText()).trim();
    const m = txt.match(/^(\d+) events$/);
    if (m) return Number(m[1]);
  }
  // Fallback: count any `<li>` inside the deepest `<ul>` near the
  // "Activity" header. This is a soft fallback — the counter span is the
  // authoritative source.
  return await page.locator('ul > li').count();
}

/** Kill any process listening on a TCP port. */
function killPort(port: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "$pids = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess; foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' },
      );
      return;
    }

    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((pid) => Number(pid.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);

    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* process may have already exited */
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Wait until http://127.0.0.1:<port>/<path> returns a 2xx (or until deadline). */
async function waitForUp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Spawn Hono in the background with optional extra env. */
function startHono(extraEnv: Record<string, string> = {}): ChildProcess {
  // detached + 'ignore' stdio so the test runner doesn't track its lifetime.
  // On Windows, `tsx` is via the `.cmd` shim; shell: true is harmless elsewhere.
  const child = spawn('pnpm', ['dev'], {
    cwd: REPO_ROOT,
    shell: true,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
  child.unref();
  return child;
}

test.describe('L. WS reconnect + dedup', () => {
  test('L.1–L.4 kill → disconnect → restart → reconnect, no chat dedup leak', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await gotoShell(page);
    // Active project for the WS test. Prefer Project B (has a non-trivial
    // events.jsonl from earlier manual smoke tests, so the dedup signal is
    // meaningful). Fallback to Q14 Project A if Project B is gone.
    let target = await findProjectBySlug(request, 'project-b');
    if (!target) target = await findProjectBySlug(request, 'q14-project-a');
    expect(target, 'no project to test against').not.toBeNull();
    await page
      .getByRole('button', { name: target!.name, exact: true })
      .first()
      .click();
    await expect(
      page.locator('button[aria-label="Project settings"]'),
    ).toBeVisible({ timeout: 5_000 });

    // Wait for ws: open.
    const wsPill = page.locator('span[title^="WS:"]');
    await expect(wsPill).toHaveText(/ws: open/, { timeout: 10_000 });

    // Wait for the initial events.jsonl replay to settle, then snapshot the
    // activity-panel event count. The ActivityPanel renders an "N events"
    // counter from the deduped buffer — the count itself is the dedup
    // signal (a broken seenTs would make this counter ~double after a
    // reconnect/replay).
    await page.waitForTimeout(1_500);
    const preCount = await readEventCount(page);
    console.log(`[L.dedup] pre-kill row count = ${preCount}`);

    // L.1 — Stop Hono.
    killPort(4040);
    // L.2 — header flips to ws: closed within ~2s.
    await expect(wsPill).toHaveText(/ws: closed/, { timeout: 5_000 });

    // L.3 — restart Hono (no env var; the picker tests are done).
    startHono();
    const up = await waitForUp(`${HONO}/api/projects`, 30_000);
    expect(up, 'Hono did not return to a healthy state').toBe(true);

    // Wait for the UI to reconnect (backoff: 2 → 5 → 15 → 30). Up to 35s.
    await expect(wsPill).toHaveText(/ws: open/, { timeout: 35_000 });

    // L.4 — after reconnect, the activity rows count should match (Q13 dedup
    // catches the events.jsonl replay). Allow a small race window for the
    // replay messages to be processed.
    await page.waitForTimeout(2_000);
    const postCount = await readEventCount(page);
    console.log(`[L.dedup] post-reconnect row count = ${postCount}`);
    // Critical assertion: post-reconnect count is NOT greater than pre-kill.
    // (Equality is ideal; if any new event arrived for unrelated reasons,
    // we'd see >, but in a quiet test env the count should match exactly.)
    expect(
      postCount,
      `dedup leak: pre=${preCount} post=${postCount}`,
    ).toBeLessThanOrEqual(preCount);
  });

  test('L.5 backoff resets on each successful open', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await gotoShell(page);
    // Make sure WS is open before we cycle.
    const wsPill = page.locator('span[title^="WS:"]');
    let target = await findProjectBySlug(request, 'q14-project-a');
    if (!target) target = await findProjectBySlug(request, 'project-b');
    expect(target).not.toBeNull();
    await page
      .getByRole('button', { name: target!.name, exact: true })
      .first()
      .click();
    await expect(wsPill).toHaveText(/ws: open/, { timeout: 10_000 });

    // Cycle 1: kill → expect reconnect within ~5s (backoff resets to 2s on
    // each successful open, so we should see closed → connecting → open
    // inside the 2s delay window).
    const cycleStart1 = Date.now();
    killPort(4040);
    await expect(wsPill).toHaveText(/ws: closed/, { timeout: 5_000 });
    startHono();
    await waitForUp(`${HONO}/api/projects`, 30_000);
    await expect(wsPill).toHaveText(/ws: open/, { timeout: 35_000 });
    const cycle1Ms = Date.now() - cycleStart1;

    // Cycle 2: same again. If backoff were stuck at 30s cap, we'd see this
    // cycle take >25s. We expect both cycles to be in similar ranges.
    const cycleStart2 = Date.now();
    killPort(4040);
    await expect(wsPill).toHaveText(/ws: closed/, { timeout: 5_000 });
    startHono();
    await waitForUp(`${HONO}/api/projects`, 30_000);
    await expect(wsPill).toHaveText(/ws: open/, { timeout: 35_000 });
    const cycle2Ms = Date.now() - cycleStart2;

    // Backoff reset signal: cycle 2 should NOT be ≥ 30s longer than cycle 1.
    // A stuck-at-30s cap would show cycle 2 ≈ cycle 1 + 28s.
    expect(
      cycle2Ms,
      `backoff did not reset; cycle1=${cycle1Ms}ms cycle2=${cycle2Ms}ms`,
    ).toBeLessThan(cycle1Ms + 25_000);
  });
});
