/**
 * The fixture reports a click whose press and release a layout change split
 * (`helpers/split-clicks.mjs`), and nothing else: not a click that lands, not
 * a drag, not a control its own press covers.
 */
import { expect, test } from './helpers/test.mjs';
import { expectNoSplitClicks, takeSplitClicksOn } from './helpers/split-clicks.mjs';

const PAGE = `<!doctype html><title>split clicks</title>
<style>body { margin: 0 } button { display: block; width: 200px; height: 40px }</style>
<div id="above"></div>
<button id="pressed"><span id="label">Pressed</span></button>
<button id="below">Below</button>
<div id="cover" style="display:none;position:fixed;inset:0"></div>`;

async function openPage(page) {
  await page.route('**/split-clicks.html', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('/split-clicks.html');
  await page.evaluate(() => {
    window.clicked = [];
    document.addEventListener('click', event => window.clicked.push(event.target.id || event.target.tagName), true);
  });
}

test('a press and a release with the page moved in between is reported, with what was pressed', async ({ page }) => {
  await openPage(page);
  await page.mouse.move(100, 20);
  await page.mouse.down();
  // The content above grows: the pressed button is no longer under the pointer.
  await page.evaluate(() => { document.getElementById('above').style.height = '60px'; });
  await page.mouse.up();
  expect(await page.evaluate(() => window.clicked)).not.toContain('label');
  expect(() => expectNoSplitClicks()).toThrow(/pressed on one element and released on another[\s\S]*"within":\["label","pressed"\]/);
  // Reported once: the test itself ends clean.
  expect(() => expectNoSplitClicks()).not.toThrow();

  // A helper takes the clicks on its own control, pressed on the control or on anything in it.
  await page.evaluate(() => { document.getElementById('above').style.height = '0px'; });
  await page.mouse.move(100, 20);
  await page.mouse.down();
  await page.evaluate(() => { document.getElementById('above').style.height = '60px'; });
  await page.mouse.up();
  expect(await takeSplitClicksOn(page, 'below')).toBe(0);
  // Both presses were in it, on its label: a report stays in the page until a helper takes it.
  expect(await takeSplitClicksOn(page, 'pressed')).toBe(2);
  expect(await takeSplitClicksOn(page, 'pressed')).toBe(0);
  expect(() => expectNoSplitClicks()).not.toThrow();
});

test('a click that lands, a drag, and a control its own press covers or hides are not reported', async ({ page }) => {
  await openPage(page);
  await page.locator('#pressed').click();
  expect(await page.evaluate(() => window.clicked)).toEqual(['label']);
  // A drag: the pointer moves between the press and the release.
  await page.mouse.move(100, 20);
  await page.mouse.down();
  await page.mouse.move(100, 60);
  await page.mouse.up();
  // A press that covers its own control (a menu, a veil): the control has not moved.
  await page.evaluate(() => {
    document.getElementById('pressed').addEventListener('pointerdown', () => {
      document.getElementById('cover').style.display = 'block';
    });
  });
  await page.mouse.move(100, 20);
  await page.mouse.down();
  await page.mouse.up();
  // A press that hides its own control (a menu's option, chosen on the press).
  await page.evaluate(() => {
    document.getElementById('cover').style.display = 'none';
    document.getElementById('below').addEventListener('pointerdown', event => { event.currentTarget.style.display = 'none'; });
  });
  await page.mouse.move(100, 60);
  await page.mouse.down();
  await page.mouse.up();
  expect(() => expectNoSplitClicks()).not.toThrow();
});
