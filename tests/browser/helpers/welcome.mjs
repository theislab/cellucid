import { expect } from '@playwright/test';

export async function dismissWelcome(page) {
  const modal = page.locator('#welcome-modal');
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
}
