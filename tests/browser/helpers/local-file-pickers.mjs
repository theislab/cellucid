/**
 * The browser's file pickers, answered for a spec (Chromium: the only engine
 * that gives a page handles of the files it opens).
 *
 * File… calls `showOpenFilePicker`, which no test can answer (with
 * Playwright's file chooser watched, Chromium aborts it as intercepted); it
 * is given a file of the origin-private file system holding the fixture (a
 * real `FileSystemFileHandle`, kept in IndexedDB and read back after a
 * reload). Leave to read it is the browser's to give: granted for what was
 * picked in this page, else asked for in a click and granted; each request
 * is recorded with whether the page had the click's user activation then
 * (`window.__reopenAsked`).
 */
import { expect } from './test.mjs';
import { openCollapsedPanels } from './panels.mjs';

/**
 * Answer File… with `fixture` (`{name, url}`: the file's name and where the
 * page fetches its bytes), on every page of `page` from now on.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{name: string, url: string}} fixture
 */
export async function answerPickers(page, fixture) {
  await page.addInitScript(({ name, url }) => {
    const asked = window.__reopenAsked = [];
    let granted = false;
    window.showOpenFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name, { create: true });
      if ((await handle.getFile()).size === 0) {
        const writable = await handle.createWritable();
        await writable.write(await (await fetch(url)).arrayBuffer());
        await writable.close();
      }
      granted = true;
      return [handle];
    };
    FileSystemHandle.prototype.queryPermission = async function queryPermission() {
      return granted ? 'granted' : 'prompt';
    };
    FileSystemHandle.prototype.requestPermission = async function requestPermission({ mode }) {
      asked.push({ mode, inClick: navigator.userActivation.isActive });
      granted = true;
      return 'granted';
    };
  }, fixture);
}

/**
 * Open… › File…, as a person does (the panels opened first).
 *
 * @param {import('@playwright/test').Page} page
 */
export async function pickWithFileItem(page) {
  await openCollapsedPanels(page);
  await page.locator('#user-data-open-btn').click();
  await expect(page.locator('#user-data-file-item')).toBeVisible();
  await page.locator('#user-data-file-item').click();
}
