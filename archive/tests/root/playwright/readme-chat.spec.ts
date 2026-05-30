// Throwaway — drive a live orchestrator turn and capture the hero chat shot.
import { test, expect } from '@playwright/test';

const OUT = 'docs/screenshots';
const VIEW = { width: 1512, height: 945 };

test.setTimeout(240_000);

test('readme: live orchestrator chat', async ({ page }) => {
  page.on('dialog', (d) => d.accept()); // confirm() on "+ New session"

  await page.setViewportSize(VIEW);
  await page.goto('http://127.0.0.1:5173/');
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'orchestrator', exact: true }).first().click();
  await page.waitForTimeout(800);

  // Fresh session so we control the content. Accept the confirm() dialog.
  await page.getByRole('button', { name: /New session/i }).first().click();

  // New session spawns: the "session ended" banner should clear and the
  // composer should mount. Wait for MCP tools to bind first.
  await expect(page.getByText(/\d+\s+tools/i).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000); // settle past banner -> MCP register

  const composer = page.getByPlaceholder(/Message the orchestrator/i);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.click();
  await composer.fill(
    "Give me a quick rundown of this project — what's sitting in the Draft column right now, and is anything waiting on my input?",
  );
  await composer.press('Enter');

  // Wait for the turn to settle: poll body text length until stable.
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const len = (await page.locator('body').innerText()).length;
    if (len === last && len > 0) {
      stable += 1;
      if (stable >= 3) break; // ~9s unchanged
    } else {
      stable = 0;
      last = len;
    }
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/01-orchestrator.png`, fullPage: false });
});
