// Throwaway diagnostic — drive the live UI, screenshot it, report computed
// widths of the three Shell panels so we can see what the user actually sees.

import { test, expect } from '@playwright/test';

test('snapshot: rail widths + layout', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:5173/');
  await expect(page.getByText('PROJECT COMPANION')).toBeVisible({ timeout: 10_000 });

  // Let any HMR / hydration settle.
  await page.waitForTimeout(500);

  // v4 emits [data-group] on the Group and [data-panel] on each Panel.
  const groupAttrs: Record<string, string> = {};
  const groupEl = page.locator('[data-group]').first();
  for (const attr of ['data-group', 'id', 'class', 'style']) {
    const v = await groupEl.getAttribute(attr);
    if (v !== null) groupAttrs[attr] = v;
  }
  const groupBox = await groupEl.boundingBox();
  groupAttrs['boundingWidth'] = String(groupBox?.width ?? -1);
  groupAttrs['boundingHeight'] = String(groupBox?.height ?? -1);
  // Also dump parent container width
  const parentWidth = await groupEl.evaluate((el) => {
    const p = el.parentElement;
    return p ? `${p.getBoundingClientRect().width}` : 'no-parent';
  });
  groupAttrs['parentWidth'] = parentWidth;
  const panels = await page.locator('[data-panel]').all();
  const widths: Array<{ attrs: Record<string, string>; px: number }> = [];
  for (const p of panels) {
    const box = await p.boundingBox();
    const attrs: Record<string, string> = {};
    for (const attr of ['data-panel', 'id', 'style']) {
      const v = await p.getAttribute(attr);
      if (v !== null) attrs[attr] = v;
    }
    widths.push({ attrs, px: box?.width ?? -1 });
  }

  const localStorage = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)!;
      out[k] = window.localStorage.getItem(k) ?? '';
    }
    return out;
  });

  await page.screenshot({ path: 'tests/playwright/snap-shell.png', fullPage: false });

  console.log('GROUP ATTRS:', JSON.stringify(groupAttrs, null, 2));
  console.log('PANEL WIDTHS:', JSON.stringify(widths, null, 2));
  console.log('LOCALSTORAGE KEYS:', Object.keys(localStorage));
  console.log('LOCALSTORAGE FULL:', JSON.stringify(localStorage, null, 2));
  console.log('CONSOLE ERRORS:', consoleErrors);
});
