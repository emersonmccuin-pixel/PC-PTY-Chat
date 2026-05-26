// Section 10 Phase 2 — onboarding wizard gate.
//
// `?onboarding=sim` forces the gate open on a faked blank machine with faked
// install/sign-in actions (the dev "fresh machine" switch) — fully client-side,
// so this spec needs no external deps. `?onboarding=force` opens the gate with
// the REAL preflight (all-green on a dev box that has claude/git/auth).

import { test, expect } from '@playwright/test';

test.describe('Section 10 Phase 2 — onboarding wizard', () => {
  test('sim mode: walks blank machine through to "all set"', async ({ page }) => {
    await page.goto('/?onboarding=sim');

    await expect(page.getByRole('heading', { name: 'Welcome to Caisson' })).toBeVisible();
    await page.getByRole('button', { name: 'Get started' }).click();

    // Claude step — not installed in the fake machine.
    await expect(page.getByRole('heading', { name: 'Install Claude Code' })).toBeVisible();
    await page.getByRole('button', { name: 'Install Claude Code' }).click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible({ timeout: 6000 });
    await page.getByRole('button', { name: 'Continue' }).click();

    // Git step.
    await expect(page.getByRole('heading', { name: 'Install Git' })).toBeVisible();
    await page.getByRole('button', { name: 'Install Git' }).click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible({ timeout: 6000 });
    await page.getByRole('button', { name: 'Continue' }).click();

    // Sign-in step.
    await expect(page.getByRole('heading', { name: 'Sign in to Claude' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in to Claude' }).click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible({ timeout: 6000 });
    await page.getByRole('button', { name: 'Continue' }).click();

    // Projects-folder step (has a default → Continue is enabled).
    await expect(page.getByRole('heading', { name: 'Where should your projects live?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose folder…' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Done.
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create your first project' })).toBeEnabled();
  });

  test('force mode: real preflight shows Claude already found on a dev box', async ({ page }) => {
    await page.goto('/?onboarding=force');
    await expect(page.getByRole('heading', { name: 'Welcome to Caisson' })).toBeVisible();
    await page.getByRole('button', { name: 'Get started' }).click();
    // Dev box already has Claude → the step reports it found (no install button).
    await expect(page.getByText(/Claude Code .*found/i)).toBeVisible({ timeout: 6000 });
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  });
});
