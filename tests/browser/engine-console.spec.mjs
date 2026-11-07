/**
 * The console warnings `helpers/engine-console.mjs` sets aside are the
 * engine's own, on a page that runs none of Cellucid's code, and the
 * exception is no wider than that text: a page writing the same sentence is
 * still a page warning.
 */
import { expect, test } from './helpers/test.mjs';
import { isFirefoxSafeResolveReorderingWarning } from './helpers/engine-console.mjs';

const PAGE = '<!doctype html><title>engine console</title>';
const SENTENCE =
  'The execution of microtasks on this page was reordered to avoid unsafe execution.';

async function openPage(page) {
  await page.route('**/engine-console.html', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('/engine-console.html');
}

test('Firefox warns of its own reordering when a page constructs a bare TransformStream', async ({ browserName, page }) => {
  test.skip(browserName !== 'firefox', 'the warning is Gecko\'s (bugs 2071285 and 2076900)');
  const warnings = [];
  page.on('console', message => {
    if (message.type() === 'warning') warnings.push(message);
  });
  await openPage(page);
  await page.evaluate(() => {
    new TransformStream();
  });
  await expect.poll(() => warnings.length).toBe(1);
  expect(isFirefoxSafeResolveReorderingWarning(warnings[0])).toBe(true);
});

test('a page that writes the same sentence to the console is not the engine', async ({ page }) => {
  const warnings = [];
  page.on('console', message => {
    if (message.type() === 'warning') warnings.push(message);
  });
  await openPage(page);
  await page.evaluate(sentence => {
    console.warn(sentence);
    console.warn(`[JavaScript Warning: "${sentence}" {file: "${location.href}" line: 0}]`);
  }, SENTENCE);
  await expect.poll(() => warnings.length).toBe(2);
  expect(warnings.map(message => isFirefoxSafeResolveReorderingWarning(message))).toEqual([false, false]);
});
