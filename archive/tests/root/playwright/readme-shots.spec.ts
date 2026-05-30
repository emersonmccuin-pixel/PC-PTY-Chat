// Throwaway — capture README screenshots of the live UI.
import { test, expect, type Page } from '@playwright/test';

const OUT = 'docs/screenshots';
const VIEW = { width: 1512, height: 945 };

async function shell(page: Page) {
  await page.setViewportSize(VIEW);
  await page.goto('http://127.0.0.1:5173/');
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(700);
}

async function tab(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).first().click();
  await page.waitForTimeout(1200);
}

test('readme: orchestrator', async ({ page }) => {
  await shell(page);
  await tab(page, 'orchestrator');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/01-orchestrator.png`, fullPage: false });
});

test('readme: work-items', async ({ page }) => {
  await shell(page);
  await tab(page, 'work items');
  await page.screenshot({ path: `${OUT}/02-work-items.png`, fullPage: false });
});

test('readme: workflows', async ({ page }) => {
  await shell(page);
  await tab(page, 'workflows');
  await page.screenshot({ path: `${OUT}/03-workflows.png`, fullPage: false });
});

test('readme: agents', async ({ page }) => {
  await shell(page);
  await tab(page, 'agents');
  await page.screenshot({ path: `${OUT}/04-agents.png`, fullPage: false });
});
