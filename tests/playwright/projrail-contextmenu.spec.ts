// 5+.1 regression guard. Bug: the contextmenu event that opened the menu
// also bubbled to the window-level dismiss listener attached by the same
// state-change useEffect, immediately closing the menu. Fix: stopPropagation
// on the opening contextmenu. Keep this spec so the menu never silently
// regresses to "0 menu elements rendered" again.

import { test, expect } from '@playwright/test';

test('right-clicking a project row opens (and keeps open) the context menu', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('button:has-text("Project B"), button:has-text("Caisson")', {
    timeout: 10_000,
  });
  const row = page.locator('button').filter({ hasText: 'Project B' }).first();
  await expect(row).toBeVisible();

  await row.click({ button: 'right' });

  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible({ timeout: 3000 });
  // All six D86 items render.
  await expect(page.locator('[role="menuitem"]')).toHaveCount(6);
  await expect(page.locator('[role="menuitem"]', { hasText: 'Open project settings' })).toBeVisible();
});
