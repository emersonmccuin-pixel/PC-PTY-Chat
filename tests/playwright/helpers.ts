import { type APIRequestContext, type Page, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HONO = 'http://127.0.0.1:4040';
export const CHANNEL = 'http://127.0.0.1:8788';
export const FIXTURE_ROOT = join(tmpdir(), 'pc-q14-test');
export const EMPTY = join(FIXTURE_ROOT, 'empty-folder');
export const WITH_FILES = join(FIXTURE_ROOT, 'folder-with-files');

export interface Project {
  id: string;
  slug: string;
  name: string;
  folderPath: string;
  gitRemote: string | null;
  stages: { id: string; name: string; order: number }[];
}

export async function listProjects(
  req: APIRequestContext,
  includeDeleted = false,
): Promise<Project[]> {
  const url = `${HONO}/api/projects${includeDeleted ? '?include_deleted=1' : ''}`;
  const r = await req.get(url);
  if (!r.ok()) throw new Error(`listProjects ${r.status()}`);
  const j = (await r.json()) as { projects: Project[] };
  return j.projects;
}

export async function findProjectBySlug(
  req: APIRequestContext,
  slug: string,
  includeDeleted = false,
): Promise<Project | null> {
  const list = await listProjects(req, includeDeleted);
  return list.find((p) => p.slug === slug) ?? null;
}

export async function cleanupQ14(req: APIRequestContext): Promise<void> {
  const items = await listProjects(req, true);
  for (const p of items) {
    if (!p.slug.startsWith('q14-')) continue;
    // Try to remove files (idempotent — server returns 200 even when nothing
    // is on disk), then soft-delete the row.
    await req.delete(`${HONO}/api/projects/${p.id}/files`).catch(() => null);
    await req.delete(`${HONO}/api/projects/${p.id}`).catch(() => null);
  }
}

export async function setProjectsFolder(
  req: APIRequestContext,
  value: string,
): Promise<void> {
  const r = await req.patch(`${HONO}/api/settings`, {
    data: { projectsFolder: value },
  });
  if (!r.ok()) throw new Error(`setProjectsFolder ${r.status()}`);
}

export async function getSettings(req: APIRequestContext): Promise<{
  dataDir: string;
  projectsFolder: string;
  telemetryOptIn: boolean;
  activityPanel: { open: boolean; showAllProjects: boolean };
}> {
  const r = await req.get(`${HONO}/api/settings`);
  if (!r.ok()) throw new Error(`getSettings ${r.status()}`);
  const j = (await r.json()) as {
    settings: {
      dataDir: string;
      projectsFolder: string;
      telemetryOptIn: boolean;
      activityPanel: { open: boolean; showAllProjects: boolean };
    };
  };
  return j.settings;
}

export async function patchSettings(
  req: APIRequestContext,
  patch: Record<string, unknown>,
): Promise<void> {
  const r = await req.patch(`${HONO}/api/settings`, { data: patch });
  if (!r.ok()) throw new Error(`patchSettings ${r.status()}`);
}

export async function probeFolder(
  req: APIRequestContext,
  path: string,
): Promise<{
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  hasFiles: boolean;
  fileCount: number;
}> {
  const r = await req.post(`${HONO}/api/fs/probe`, { data: { path } });
  if (!r.ok()) throw new Error(`probeFolder ${r.status()}`);
  const j = (await r.json()) as { probe: never };
  return j.probe;
}

export async function createProjectViaApi(
  req: APIRequestContext,
  args: { name: string; folder_path: string; mode: 'init-empty' | 'init-in-place' },
): Promise<Project> {
  const r = await req.post(`${HONO}/api/projects`, { data: args });
  if (!r.ok()) {
    throw new Error(`createProject ${r.status()}: ${await r.text()}`);
  }
  const j = (await r.json()) as { project: Project };
  return j.project;
}

export async function waitForRail(page: Page, name: string): Promise<void> {
  await expect(
    page.getByRole('button', { name, exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
}

export async function gotoShell(page: Page): Promise<void> {
  await page.goto('/');
  // Section 22.4 — wait on the stable shell testid, not brand text. The
  // brand string changes across themes ("CAISSON" → "caisson");
  // the testid is contractual.
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Selects a project in the rail and waits for the tab strip to render.
 * Uses the rail button's project title.
 */
export async function selectProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
  await expect(
    page.locator('button[aria-label="Project settings"]'),
  ).toBeVisible({ timeout: 5_000 });
}

export async function setActiveTab(
  page: Page,
  tab: 'Orchestrator' | 'Work items' | 'Workflows',
): Promise<void> {
  const label = tab === 'Orchestrator' ? 'chat' : tab;
  await page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first().click();
}
