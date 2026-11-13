/**
 * A file input whose chooser a spec intercepts hears what it hears from a
 * person who chooses a file: `input`, `change`, and no `cancel`, in every
 * engine (`helpers/file-chooser-cancel.mjs`: Playwright's Firefox answers an
 * intercepted picker as a dismissed one first). A page's own `cancel` still
 * reaches it. One input clicked again and again opens a chooser every time.
 */
import { expect, test } from './helpers/test.mjs';

const PAGE = `<!doctype html><title>file chooser</title>
<button id="open">Open</button>
<script>
  window.heard = [];
  document.getElementById('open').addEventListener('click', () => {
    // As the session picker opens one: a fresh input, in the document.
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'chosen';
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    document.body.appendChild(input);
    for (const type of ['input', 'change', 'cancel']) {
      input.addEventListener(type, event => {
        window.heard.push({ type, trusted: event.isTrusted, files: input.files.length });
      });
    }
    input.click();
  });
</script>`;

// As My datasets' Import… opens one: the same input every time, emptied first.
const REUSED_PAGE = `<!doctype html><title>file chooser</title>
<button id="open">Open</button><input type="file" id="reused" hidden>
<script>
  window.chosen = [];
  const input = document.getElementById('reused');
  input.addEventListener('change', () => { window.chosen.push(input.files[0]?.name ?? null); });
  document.getElementById('open').addEventListener('click', () => {
    input.value = '';
    input.click();
  });
</script>`;

async function openPage(page) {
  await page.route('**/file-chooser.html', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('/file-chooser.html');
}

test('an intercepted file chooser, a file set: input and change, no cancel', async ({ page }) => {
  await openPage(page);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#open').click();
  await (await chooser).setFiles({
    name: 'chosen.cellucid-session',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('chosen'),
  });
  // Whether `input` and `change` are trusted is the emulation's (Playwright's
  // Firefox dispatches them from the page, untrusted): their order is the page's.
  await expect.poll(() => page.evaluate(() => window.heard.map(({ type, files }) => ({ type, files })))).toEqual([
    { type: 'input', files: 1 },
    { type: 'change', files: 1 },
  ]);
});

test('one file input, its value cleared and clicked again, opens a chooser at every click', async ({ page }) => {
  // An emptied input makes Firefox look up its last upload folder before it
  // creates the picker. Each `waitForEvent` turns interception off once its
  // event comes; when that reaches Playwright's Firefox first, Firefox's own
  // picker is created, never closed, and the input's next click opens none
  // (`playwright.config.mjs`, `widget.disable_file_pickers`). Without that
  // preference a pick is now and then lost, never a page's first, and the pick
  // after a lost one has no chooser (measured: 38_decisions_testing_and_hosted_runners.md).
  await page.route('**/file-chooser-reused.html', route => route.fulfill({ contentType: 'text/html', body: REUSED_PAGE }));
  await page.goto('/file-chooser-reused.html');
  const names = Array.from({ length: 20 }, (_, index) => `pick-${index}.txt`);
  for (const name of names) {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#open').click();
    await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
    await expect.poll(() => page.evaluate(() => window.chosen.at(-1))).toBe(name);
  }
  expect(await page.evaluate(() => window.chosen)).toEqual(names);
});

test('a cancel the page dispatches itself still reaches the input', async ({ page }) => {
  await openPage(page);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#open').click();
  await chooser;
  await page.evaluate(() => {
    document.getElementById('chosen').dispatchEvent(new Event('cancel'));
  });
  expect(await page.evaluate(() => window.heard)).toEqual([
    { type: 'cancel', trusted: false, files: 0 },
  ]);
});
