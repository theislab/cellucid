/**
 * A spec holds a download to the name the application asked for and to the
 * name the browser saves any file asked to be that name
 * (`helpers/downloads.mjs`): never to one engine's rewriting of it (Linux
 * WebKit with libsoup 3.6.6 saves `My report.html` as `My_report.html`).
 */
import { expect, test } from './helpers/test.mjs';
import { askedDownload, expectDownloadNamed } from './helpers/downloads.mjs';

async function openPage(page) {
  await page.route('**/download-names.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>download names</title>' }));
  await page.goto('/download-names.html');
}

/** The application's own download (`utils/download.js`) of a small Blob. */
function download(page, name, type) {
  return Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async ({ name, type }) => {
      const { downloadBlob } = await import('/assets/js/app/utils/download.js');
      downloadBlob(new Blob(['a,b\n1,2\n'], { type }), name);
    }, { name, type }),
  ]).then(([file]) => file);
}

test('the name asked for is the one held, whatever the engine saves it as', async ({ page }) => {
  await openPage(page);
  const file = await download(page, 'My report, final.csv', 'text/csv');
  expect(await askedDownload(file)).toEqual({ name: 'My report, final.csv', type: 'text/csv' });
  expect(await expectDownloadNamed(file, 'My report, final.csv')).toBe('My report, final.csv');
  await expectDownloadNamed(file, /^My report, final\.csv$/);
  await file.cancel();
});

test('two downloads in a row are told apart by their own address', async ({ page }) => {
  await openPage(page);
  const first = await download(page, 'first.csv', 'text/csv');
  const second = await download(page, 'second table.csv', 'text/csv');
  await expectDownloadNamed(second, 'second table.csv');
  await expectDownloadNamed(first, 'first.csv');
  await Promise.all([first.cancel(), second.cancel()]);
});
