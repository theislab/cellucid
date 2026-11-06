/**
 * The State panel's way to a session file, as a person takes it: Share… ›
 * Save file writes one (the history, as the dialog opens: every tracker
 * with its main and shown branches, notes, no conversations), and Load… ›
 * Open a session file… opens the file chooser (inside the click).
 */
import { expect } from './test.mjs';

/** Share… › Save file. Wait for the page's `download` before calling. */
export async function clickSaveSession(page, { chats = false } = {}) {
  await page.locator('#history-share-btn').click();
  await expect(page.locator('#history-share-dialog')).toBeVisible();
  if (chats) await page.locator('#history-share-chats').check();
  await page.locator('#history-share-save').click();
}

/** Load… › Open a session file…. Wait for the page's `filechooser` before calling. */
export async function clickLoadSession(page) {
  await page.locator('#history-load-btn').click();
  await page.locator('#load-state-btn').click();
}
