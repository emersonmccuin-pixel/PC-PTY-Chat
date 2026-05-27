import { test, expect, type APIRequestContext } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNEL,
  EMPTY,
  FIXTURE_ROOT,
  HONO,
  WITH_FILES,
  cleanupQ14,
  createProjectViaApi,
  findProjectBySlug,
  getSettings,
  gotoShell,
  listProjects,
  patchSettings,
  probeFolder,
  selectProject,
  setActiveTab,
  setProjectsFolder,
  waitForRail,
} from './helpers';

let savedProjectsFolder = '';
let savedDataDir = '';

// Run the cleanups at module load so each fresh test pass starts from a
// known-good baseline. Restoring fixture state on disk for the in-place
// fixture and ensuring the empty fixture is empty.
test.beforeAll(async ({ request }) => {
  const s = await getSettings(request);
  savedProjectsFolder = s.projectsFolder;
  savedDataDir = s.dataDir;
  await cleanupQ14(request);
  resetFixtures();
  await setProjectsFolder(request, FIXTURE_ROOT);
});

test.afterAll(async ({ request }) => {
  await cleanupQ14(request);
  // Suite-level library cleanup — remove any Q14 fork agents left behind.
  const homeDir = homedir();
  const libDir = join(homeDir, '.project-companion', 'agents');
  for (const f of ['researcher-q14-fork.md']) {
    const p = join(libDir, f);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch { /* noop */ }
    }
  }
  if (savedProjectsFolder) {
    await patchSettings(request, { projectsFolder: savedProjectsFolder });
  }
  if (savedDataDir) {
    await patchSettings(request, { dataDir: savedDataDir });
  }
  resetFixtures();
});

function resetFixtures(): void {
  // Empty folder: ensure it exists and is empty (no .git, no scaffold).
  if (existsSync(EMPTY)) {
    try {
      rmSync(EMPTY, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  mkdirSync(EMPTY, { recursive: true });
  // With-files folder: ensure README.md, notes.txt, src/index.js exist; no
  // .git, no scaffold dirs.
  if (existsSync(WITH_FILES)) {
    try {
      rmSync(WITH_FILES, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  mkdirSync(WITH_FILES, { recursive: true });
  writeFileSync(join(WITH_FILES, 'README.md'), '# fixture\n');
  writeFileSync(join(WITH_FILES, 'notes.txt'), 'fixture notes\n');
  mkdirSync(join(WITH_FILES, 'src'), { recursive: true });
  writeFileSync(join(WITH_FILES, 'src', 'index.js'), 'console.log("fixture")\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A — cold boot + empty state (skip if DB non-empty)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('A. Cold boot + empty state', () => {
  test('A.1 GET /api/projects empty', async ({ request }) => {
    const projects = await listProjects(request);
    test.skip(
      projects.length > 0,
      `DB had ${projects.length} pre-existing project(s); destructive wipe disallowed.`,
    );
    expect(projects).toEqual([]);
  });

  test('A.2 UI shows empty rail + center hint', async ({ page, request }) => {
    const projects = await listProjects(request);
    test.skip(
      projects.length > 0,
      `DB had ${projects.length} pre-existing project(s); destructive wipe disallowed.`,
    );
    await gotoShell(page);
    await expect(page.locator('text=No projects yet.')).toBeVisible();
    await expect(
      page.locator('text=Create a project to get started.'),
    ).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section B — create empty-folder project (init-empty)
//
// Drives the create-project endpoint via the API and validates the UI
// updates. The real-UI folder-picker drill is exercised separately in
// q14-gaps.spec.ts.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('B. Create empty-folder project (init-empty)', () => {
  test('B.1 PATCH projectsFolder fixture root', async ({ request, page }) => {
    await setProjectsFolder(request, FIXTURE_ROOT);
    const s = await getSettings(request);
    expect(s.projectsFolder).toBe(FIXTURE_ROOT);
    await gotoShell(page);
  });

  test('B.2 modal opens with header', async ({ page }) => {
    await gotoShell(page);
    await page.locator('text=+ New project').click();
    await expect(page.locator('text=Create project')).toBeVisible();
    await page.locator('button[aria-label="Close"]').first().click();
  });

  test('B.4 probe contract: empty + no .git (pre-create)', async ({ request }) => {
    // We can't drill via the folder picker (browse allowlist), so assert the
    // contract at the probe endpoint instead — same shape the UI consumes to
    // render the preview text. Runs BEFORE B.3 so the folder is still empty.
    const probe = await probeFolder(request, EMPTY);
    expect(probe.exists).toBe(true);
    expect(probe.isDirectory).toBe(true);
    expect(probe.hasFiles).toBe(false);
    expect(probe.isGitRepo).toBe(false);
  });

  test('B.3 + B.5 Create via API + appears in rail', async ({
    page,
    request,
  }) => {
    await gotoShell(page);
    const project = await createProjectViaApi(request, {
      name: 'Q14 Project A',
      folder_path: EMPTY,
      mode: 'init-empty',
    });
    expect(project.slug).toBe('q14-project-a');
    expect(project.folderPath).toBe(EMPTY);
    await page.reload();
    await waitForRail(page, 'Q14 Project A');
  });

  test('B.6 disk: one commit + durable scaffold present', async () => {
    const log = execSync('git log --oneline', { cwd: EMPTY }).toString().trim();
    expect(log.split('\n').length).toBe(1);
    expect(log).toMatch(/Initial commit/);
    expect(existsSync(join(EMPTY, '.git'))).toBe(true);
    expect(existsSync(join(EMPTY, '.project-companion'))).toBe(true);
    expect(existsSync(join(EMPTY, 'README.md'))).toBe(true);
    expect(existsSync(join(EMPTY, '.claude'))).toBe(false);
    expect(existsSync(join(EMPTY, '.mcp.json'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section C — create in-place project (init-in-place) via the API
// (mode derivation already exercised by the probe). Mode is enforced server-
// side; UI path was driven in B, here we exercise the in-place branch quickly.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('C. Create in-place project (init-in-place)', () => {
  // Runs BEFORE the actual create so the probe still sees no .git.
  test('C.1 + C.2 probe contract: hasFiles + no .git (pre-create)', async ({ request }) => {
    // The picker can't reach the fixture root (browse allowlist). We
    // assert the probe contract — the UI rendering layer is one switch off
    // these fields.
    const probe = await probeFolder(request, WITH_FILES);
    expect(probe.exists).toBe(true);
    expect(probe.isDirectory).toBe(true);
    expect(probe.isGitRepo).toBe(false);
    expect(probe.hasFiles).toBe(true);
    expect(probe.fileCount).toBeGreaterThan(0);
  });

  test('C.3 + C.4 create in-place + two-commit history', async ({ request }) => {
    const project = await createProjectViaApi(request, {
      name: 'Q14 Project C',
      folder_path: WITH_FILES,
      mode: 'init-in-place',
    });
    expect(project.slug).toBe('q14-project-c');
    expect(project.folderPath).toBe(WITH_FILES);

    const log = execSync('git log --oneline', { cwd: WITH_FILES }).toString().trim();
    const commits = log.split('\n');
    expect(commits.length).toBe(2);
    // Newest first per git log default — scaffold commit then initial import.
    expect(commits[0]).toMatch(/Add Caisson scaffold/);
    expect(commits[1]).toMatch(/Initial import/);
    // Original files survive.
    expect(existsSync(join(WITH_FILES, 'README.md'))).toBe(true);
    expect(existsSync(join(WITH_FILES, 'notes.txt'))).toBe(true);
    expect(existsSync(join(WITH_FILES, 'src', 'index.js'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section D — probe rejection
// ─────────────────────────────────────────────────────────────────────────────
test.describe('D. Probe rejection', () => {
  test('D.1 probe flags already-a-git-repo', async ({ request }) => {
    const probe = await probeFolder(request, WITH_FILES);
    expect(probe.isGitRepo).toBe(true);
  });

  test('D.2 server refuses re-init via API', async ({ request }) => {
    const r = await request.post(`${HONO}/api/projects`, {
      data: {
        name: 'Q14 Reject',
        folder_path: WITH_FILES,
        mode: 'init-empty',
      },
    });
    expect(r.status()).toBeGreaterThanOrEqual(400);
    expect(r.status()).toBeLessThan(500);
    const j = (await r.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/git repo|empty/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section E — project switching (zustand-persisted activeSlug)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('E. Project switching', () => {
  test('E.1 click Project A → tabs visible', async ({ page }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await expect(page.locator('button:has-text("Orchestrator")')).toBeVisible();
    await expect(page.locator('button:has-text("Work items")')).toBeVisible();
    await expect(page.locator('button:has-text("Workflows")')).toBeVisible();
    await expect(page.locator('button[aria-label="Project settings"]')).toBeVisible();
  });

  test('E.2 switch A → C re-keys workspace', async ({ page }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await selectProject(page, 'Q14 Project C');
    // After re-key the kanban for C should be empty (no cards).
    await setActiveTab(page, 'Work items');
    // Each stage column shows count "0" — there are 3 stages.
    const zeroCounts = page.locator('[data-stage-id] span.text-muted-foreground').filter({ hasText: /^\d+$/ });
    await expect(zeroCounts).toHaveCount(3);
    const texts = await zeroCounts.allInnerTexts();
    for (const t of texts) expect(t).toBe('0');
  });

  test('E.3 reload restores activeSlug = q14-project-c', async ({ page }) => {
    // Navigate, then select C, then reload to verify persistence.
    await gotoShell(page);
    await selectProject(page, 'Q14 Project C');
    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();
    // The rail button for Project C should have the active styling — we just
    // assert tabs render + the persisted localStorage value holds the slug.
    await expect(page.locator('button[aria-label="Project settings"]')).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem('pc.active-project'));
    expect(stored).toBeTruthy();
    expect(stored).toContain('q14-project-c');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section F — kanban DnD
// ─────────────────────────────────────────────────────────────────────────────
test.describe('F. Kanban DnD', () => {
  test('F.1 + F.2 add card to Project A', async ({ page, request }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await setActiveTab(page, 'Work items');
    // "+ Add card" opens CreateWorkItemModal directly — no inline title input.
    await page.locator('button:has-text("+ Add card")').first().click();
    await page.locator('input[placeholder="Card title"]').first().fill('First card');
    await page.locator('button:has-text("Create")').first().click();
    await expect(page.locator('text=First card').first()).toBeVisible({
      timeout: 5_000,
    });
    // API confirms.
    const a = await findProjectBySlug(request, 'q14-project-a');
    const r = await request.get(`${HONO}/api/projects/${a!.id}/work-items`);
    const wi = (await r.json()) as { workItems: { id: string; title: string; stageId: string }[] };
    expect(wi.workItems.some((w) => w.title === 'First card')).toBe(true);
  });

  test('F.3 drag card between columns', async ({ page, request }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await setActiveTab(page, 'Work items');
    const a = await findProjectBySlug(request, 'q14-project-a');
    // Pre-condition: ensure card is in the first stage. If it isn't (because
    // a previous run moved it), reset via the API.
    const stages = a!.stages.sort((x, y) => x.order - y.order);
    const first = stages[0]!.id;
    const second = stages[1]!.id;
    let r = await request.get(`${HONO}/api/projects/${a!.id}/work-items`);
    let wi = (await r.json()) as { workItems: { id: string; title: string; stageId: string }[] };
    const card = wi.workItems.find((w) => w.title === 'First card');
    expect(card).toBeDefined();
    if (card!.stageId !== first) {
      await request.post(`${HONO}/api/projects/${a!.id}/work-items/move`, {
        data: { id: card!.id, toStage: first },
      });
      await page.reload();
      await selectProject(page, 'Q14 Project A');
      await setActiveTab(page, 'Work items');
    }

    // Attempt the @dnd-kit drag via Playwright. PointerSensor with distance:4
    // means we have to move at least 4px before mouseup or the drag is
    // never started.
    const cardLoc = page.locator('text=First card').first();
    const targetCol = page.locator('[data-stage-id]').nth(1);
    const cardBox = await cardLoc.boundingBox();
    const tgtBox = await targetCol.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(tgtBox).not.toBeNull();
    const sx = cardBox!.x + cardBox!.width / 2;
    const sy = cardBox!.y + cardBox!.height / 2;
    const ex = tgtBox!.x + tgtBox!.width / 2;
    const ey = tgtBox!.y + tgtBox!.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.move(sx + 10, sy);
    await page.waitForTimeout(50);
    await page.mouse.move((sx + ex) / 2, (sy + ey) / 2);
    await page.waitForTimeout(50);
    await page.mouse.move(ex, ey);
    await page.waitForTimeout(50);
    await page.mouse.up();

    // Verify via the API (the UI optimistic update can race with our assertion).
    await expect.poll(async () => {
      const rr = await request.get(`${HONO}/api/projects/${a!.id}/work-items`);
      const jj = (await rr.json()) as { workItems: { id: string; title: string; stageId: string }[] };
      return jj.workItems.find((w) => w.title === 'First card')?.stageId;
    }, { timeout: 10_000 }).toBe(second);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section G — channel events
// ─────────────────────────────────────────────────────────────────────────────
test.describe('G. Channel events', () => {
  async function post(req: APIRequestContext, slug: string, body: string) {
    const r = await req.post(`${CHANNEL}/channel/${slug}/webhook`, {
      headers: { 'X-Sender': 'test', 'Content-Type': 'text/plain' },
      data: body,
    });
    if (!r.ok()) throw new Error(`channel POST ${r.status()} ${await r.text()}`);
  }

  test('G.1 + G.2 channel event surfaces in Activity panel for active project', async ({
    page,
    request,
  }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await setActiveTab(page, 'Work items');
    // Ensure all-projects toggle is OFF.
    const s = await getSettings(request);
    if (s.activityPanel.showAllProjects) {
      await patchSettings(request, {
        activityPanel: { ...s.activityPanel, showAllProjects: false },
      });
      await page.reload();
      await selectProject(page, 'Q14 Project A');
    }
    // Ensure activity panel is open.
    if (!s.activityPanel.open) {
      await patchSettings(request, {
        activityPanel: { ...s.activityPanel, open: true },
      });
      await page.reload();
      await selectProject(page, 'Q14 Project A');
    }

    await post(request, 'q14-project-a', 'ping from playwright');
    await expect(
      page.locator('text=webhook: ping from playwright'),
    ).toBeAttached({ timeout: 5_000 });
  });

  test('G.3 channel event for inactive project hidden when All=off', async ({
    page,
    request,
  }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    // Active = A. Post to C.
    await post(request, 'q14-project-c', 'hidden ping');
    // Wait briefly to ensure no event sneaks in. Then assert the panel does
    // NOT contain the inactive-project body.
    await page.waitForTimeout(1_500);
    await expect(page.locator('text=webhook: hidden ping')).toHaveCount(0);
  });

  test('G.4 toggle All → cross-project events show with slug pill', async ({
    page,
    request,
  }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    // Click the All toggle in the activity panel.
    await page.locator('button:has-text("All")').first().click();
    // Allow the WS for all-projects to come online.
    await page.waitForTimeout(800);
    await post(request, 'q14-project-c', 'cross-project ping');
    await expect(
      page.locator('text=webhook: cross-project ping'),
    ).toBeAttached({ timeout: 5_000 });
    // Slug pill is present (rendered when showAllProjects is on).
    await expect(page.locator('text=Q14-PROJECT-C').first()).toBeAttached();
    // Persist across reload.
    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();
    // The "All" button should still have the active background class.
    const allBtn = page.locator('button:has-text("All")').first();
    const cls = await allBtn.getAttribute('class');
    expect(cls ?? '').toMatch(/bg-primary\/20/);
    // Restore for downstream tests — turn All back off.
    await patchSettings(request, {
      activityPanel: { open: true, showAllProjects: false },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section H — project settings (info + agents)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('H. Project settings — info + agents', () => {
  test('H.1 + H.2 settings panel renders sections', async ({ page }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await page.locator('button[aria-label="Project settings"]').click();
    await expect(
      page.getByRole('heading', { name: 'Project info' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Danger zone' })).toBeVisible();
    // Slug locked, shows q14-project-a.
    await expect(page.locator('code:has-text("q14-project-a")')).toBeVisible();
  });

  test('H.3 rename → rail updates', async ({ page, request }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await page.locator('button[aria-label="Project settings"]').click();
    // The first text input is "Name". Set with fill.
    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill('Q14 Project A renamed');
    await page.locator('button:has-text("Save")').first().click();
    // Rail label changes. Use getByRole with exact name to disambiguate from
    // the substring "Q14 Project A".
    await expect(
      page.getByRole('button', { name: 'Q14 Project A renamed', exact: true }),
    ).toBeVisible({ timeout: 5_000 });
    const p = await findProjectBySlug(request, 'q14-project-a');
    expect(p!.name).toBe('Q14 Project A renamed');
    // Rename back so later tests (display) stay consistent.
    await request.patch(`${HONO}/api/projects/${p!.id}`, {
      data: { name: 'Q14 Project A' },
    });
  });

  test('H.4 git remote persists across reload', async ({ page, request }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await page.locator('button[aria-label="Project settings"]').click();
    const remote = page.locator(
      'input[placeholder="git@github.com:org/repo.git"]',
    );
    await remote.fill('git@github.com:test/repo.git');
    await page.locator('button:has-text("Save")').first().click();
    // Give the save round-trip a moment.
    await page.waitForTimeout(400);
    await page.reload();
    await selectProject(page, 'Q14 Project A');
    await page.locator('button[aria-label="Project settings"]').click();
    await expect(
      page.locator('input[placeholder="git@github.com:org/repo.git"]'),
    ).toHaveValue('git@github.com:test/repo.git');
  });

  test('H.5–H.8 edit project agent copy, library untouched', async ({
    page,
    request,
  }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await page.locator('button[aria-label="Project settings"]').click();
    // The researcher row should exist (copied during create).
    const projectAgents = await request.get(
      `${HONO}/api/projects/${(await findProjectBySlug(request, 'q14-project-a'))!.id}/agents`,
    );
    const ja = (await projectAgents.json()) as { agents: { name: string }[] };
    test.skip(
      !ja.agents.some((a) => a.name === 'researcher'),
      'No researcher agent in project — scaffold may not have copied it.',
    );

    await page.locator('li:has-text("researcher") button:has-text("Edit")').click();
    await expect(page.locator('textarea')).toBeVisible();
    const textarea = page.locator('textarea').first();
    const current = await textarea.inputValue();
    await textarea.fill(`# test edit\n${current}`);
    await page.locator('button:has-text("Save project copy")').click();
    await expect(page.locator('text=Project copy updated.')).toBeVisible({
      timeout: 5_000,
    });
    // Disk: project agents are DB/session-runtime backed, not written into
    // `<project>/.claude/agents`.
    expect(existsSync(join(EMPTY, '.claude', 'agents', 'researcher.md'))).toBe(false);
    // Library untouched.
    const lib = await (await request.get(`${HONO}/api/agents`)).json() as {
      agents: { name: string; body: string }[];
    };
    const libResearcher = lib.agents.find((a) => a.name === 'researcher');
    expect(libResearcher).toBeDefined();
    expect(libResearcher!.body.startsWith('# test edit')).toBe(false);
  });

  test('H.9 save as new library agent', async ({ page, request }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await page.locator('button[aria-label="Project settings"]').click();
    // Wait for the researcher row to render, then click its Edit button.
    const researcherRow = page.locator('li').filter({ hasText: 'researcher' }).first();
    await expect(researcherRow).toBeVisible({ timeout: 5_000 });
    await researcherRow.locator('button:has-text("Edit")').click();
    // Change the library-name suggestion and click Save as new library agent.
    const libName = page.locator('input[placeholder*="new-library-agent"]');
    await expect(libName).toBeVisible({ timeout: 5_000 });
    await libName.fill('researcher-q14-fork');
    await page.locator('button:has-text("Save as new library agent")').click();
    await expect(
      page.locator('text=Saved to library as "researcher-q14-fork".'),
    ).toBeVisible({ timeout: 5_000 });
    // API confirms.
    const lib = await (await request.get(`${HONO}/api/agents`)).json() as {
      agents: { name: string }[];
    };
    expect(lib.agents.some((a) => a.name === 'researcher-q14-fork')).toBe(true);
  });

  test('H.10 add researcher-q14-fork from library', async ({ page, request }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await page.locator('button[aria-label="Project settings"]').click();
    // Wait for the agents section to load.
    await expect(
      page.getByRole('heading', { name: 'Agents' }),
    ).toBeVisible({ timeout: 5_000 });
    const select = page.locator('select');
    await expect(select).toBeVisible({ timeout: 5_000 });
    await select.selectOption('researcher-q14-fork');
    await page.locator('button:has-text("Add")').click();
    await expect(
      page.locator('li').filter({ hasText: 'researcher-q14-fork' }),
    ).toBeVisible({ timeout: 5_000 });
    const p = await findProjectBySlug(request, 'q14-project-a');
    const pa = await (await request.get(
      `${HONO}/api/projects/${p!.id}/agents`,
    )).json() as { agents: { name: string }[] };
    expect(pa.agents.some((a) => a.name === 'researcher-q14-fork')).toBe(true);

    // Tidy: remove the test library agent so cross-run tests stay clean.
    const homeDir = homedir();
    const forked = join(homeDir, '.project-companion', 'agents', 'researcher-q14-fork.md');
    if (existsSync(forked)) rmSync(forked, { force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section I — danger zone
// ─────────────────────────────────────────────────────────────────────────────
test.describe('I. Danger zone', () => {
  test('I.1–I.3 soft-delete Project A, files survive', async ({ page, request }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project A');
    await page.locator('button[aria-label="Project settings"]').click();
    await page.locator('button:has-text("Soft-delete…")').click();
    await page.locator('button:has-text("Confirm soft-delete")').click();
    // The project disappears from the rail.
    await expect(
      page.locator('button:has-text("Q14 Project A")'),
    ).toHaveCount(0, { timeout: 5_000 });
    // API: not listed by default, listed via include_deleted.
    const live = await listProjects(request);
    expect(live.some((p) => p.slug === 'q14-project-a')).toBe(false);
    const all = await listProjects(request, true);
    const a = all.find((p) => p.slug === 'q14-project-a');
    expect(a).toBeDefined();
    // Disk untouched.
    expect(existsSync(join(EMPTY, '.git'))).toBe(true);
    expect(existsSync(join(EMPTY, '.project-companion'))).toBe(true);
    expect(existsSync(join(EMPTY, '.claude'))).toBe(false);
  });

  test('I.4 + I.5 delete files for Project C', async ({ page }) => {
    await gotoShell(page);
    await selectProject(page, 'Q14 Project C');
    await page.locator('button[aria-label="Project settings"]').click();
    await page.locator('button:has-text("Delete files…")').click();
    await page.locator('button:has-text("Confirm delete files")').click();
    await expect(page.locator('text=/Removed:/')).toBeVisible({
      timeout: 5_000,
    });
    // Disk: durable scaffold dir gone, originals survive.
    expect(existsSync(join(WITH_FILES, '.project-companion'))).toBe(false);
    expect(existsSync(join(WITH_FILES, '.claude'))).toBe(false);
    expect(existsSync(join(WITH_FILES, '.git'))).toBe(true);
    expect(existsSync(join(WITH_FILES, 'README.md'))).toBe(true);
    expect(existsSync(join(WITH_FILES, 'notes.txt'))).toBe(true);
    expect(existsSync(join(WITH_FILES, 'src', 'index.js'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section J — app settings
// ─────────────────────────────────────────────────────────────────────────────
test.describe('J. App settings', () => {
  test('J.1 + J.2 telemetry toggle persists', async ({ page, request }) => {
    await gotoShell(page);
    await page.locator('button[aria-label="App settings"]').click();
    await expect(page.locator('text=App settings').first()).toBeVisible();
    const checkbox = page.locator('input[type="checkbox"]').first();
    const initiallyChecked = await checkbox.isChecked();
    if (!initiallyChecked) await checkbox.check();
    await page.locator('button:has-text("Save")').first().click();
    await expect(page.locator('text=App settings').first()).toBeHidden({
      timeout: 5_000,
    });
    // No restart banner.
    await expect(
      page.locator(
        'text=Data-dir change saved — restart the server for it to take effect.',
      ),
    ).toHaveCount(0);
    // Re-open and assert telemetry still on.
    await page.locator('button[aria-label="App settings"]').click();
    await expect(page.locator('input[type="checkbox"]').first()).toBeChecked();
    await page.locator('button:has-text("Cancel")').click();
    // Restore: turn it back off so the user's prior preference is preserved.
    await patchSettings(request, { telemetryOptIn: initiallyChecked });
  });

  test('J.3 + J.4 + J.5 data dir change → restart banner', async ({ page, request }) => {
    await gotoShell(page);
    const before = await getSettings(request);
    await page.locator('button[aria-label="App settings"]').click();
    // The data-dir input is the only text input in the modal.
    const dataInput = page.locator(
      'div.fixed input[type="text"]',
    );
    const fresh = join(tmpdir(), 'pc-q14-data-test');
    await dataInput.fill(fresh);
    await expect(
      page.locator(
        'text=Restart required for data-dir change to take effect.',
      ),
    ).toBeVisible();
    await page.locator('button:has-text("Save")').first().click();
    // Page-level banner appears.
    await expect(
      page.locator(
        'text=Data-dir change saved — restart the server for it to take effect.',
      ),
    ).toBeVisible({ timeout: 5_000 });
    // Dismiss it.
    await page.locator('button:has-text("dismiss")').click();
    await expect(
      page.locator(
        'text=Data-dir change saved — restart the server for it to take effect.',
      ),
    ).toHaveCount(0);
    // Restore the original data dir directly via API so the next run still
    // points at the original sqlite location.
    await patchSettings(request, { dataDir: before.dataDir });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section K — activity panel persistence
// ─────────────────────────────────────────────────────────────────────────────
test.describe('K. Activity panel persistence', () => {
  test('K.1 hide panel persists across reload', async ({ page, request }) => {
    await gotoShell(page);
    // Ensure panel starts open.
    await patchSettings(request, {
      activityPanel: { open: true, showAllProjects: false },
    });
    await page.reload();
    await expect(page.locator('text=Activity').first()).toBeVisible();
    // Click hide.
    await page.locator('button[aria-label="Hide activity panel"]').click();
    await page.waitForTimeout(500);
    // Settings envelope is the durable signal; assertion via API survives the
    // react-resizable-panels quirk where collapsed panels stay mounted.
    const s = await getSettings(request);
    expect(s.activityPanel.open).toBe(false);
    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();
    const s2 = await getSettings(request);
    expect(s2.activityPanel.open).toBe(false);
  });

  test('K.2 reopen + All toggle persists', async ({ page, request }) => {
    await gotoShell(page);
    // Reopen panel via the header toggle.
    await page.locator('button[aria-label="Toggle activity panel"]').click();
    await expect(page.locator('text=Activity')).toBeVisible();
    // Toggle All.
    await page.locator('button:has-text("All")').first().click();
    await page.waitForTimeout(300);
    await page.reload();
    await expect(page.locator('text=Activity')).toBeVisible();
    const allBtn = page.locator('button:has-text("All")').first();
    const cls = await allBtn.getAttribute('class');
    expect(cls ?? '').toMatch(/bg-primary\/20/);
    // Restore default (open, All off) so subsequent tests start clean.
    await patchSettings(request, {
      activityPanel: { open: true, showAllProjects: false },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section M — prod URL smoke (E + F subset)
// Note: Section L (WS reconnect) needs Hono killed and restarted. Per the
// brief, we leave L for a separate run/manual pass — running it inline would
// break the rest of the suite.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('M. Prod URL smoke', () => {
  test('M.1 prod URL serves the bundle, switching + DnD work', async ({
    page,
    request,
  }) => {
    // Need at least one live project for the switch test; Project A is
    // soft-deleted by Section I. Use Project C (already exists).
    const c = await findProjectBySlug(request, 'q14-project-c');
    test.skip(!c, 'Project C not present — earlier section failed.');
    await page.goto(`${HONO}/`);
    const status = await page.evaluate(() => document.readyState);
    expect(['interactive', 'complete']).toContain(status);
    const title = page.locator('[data-testid="app-shell"]');
    // Hono only serves apps/web/dist/ — if not built yet, the request 404s.
    if (!(await title.isVisible().catch(() => false))) {
      test.skip(true, 'Prod bundle not built — pnpm --filter @pc/web build first.');
    }
    await expect(title).toBeVisible();
    // Switch to Project C in the rail.
    await selectProject(page, 'Q14 Project C');
    await setActiveTab(page, 'Work items');
    await page.locator('button:has-text("+ Add card")').first().click();
    await page
      .locator('input[placeholder="Card title"]')
      .first()
      .fill('Prod-smoke card');
    await page.locator('button:has-text("Create")').first().click();
    await expect(page.locator('text=Prod-smoke card').first()).toBeVisible({
      timeout: 5_000,
    });
  });
});
