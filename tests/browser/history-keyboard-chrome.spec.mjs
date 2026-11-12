/**
 * The keyboard and chrome walk (History v2 §6 test 12, §2.6 items 7 and 8,
 * §5 rows 47 and 48): what keys and page chrome leave in the history.
 *
 * - A camera gesture by keys is one `camera.set` step, recorded through the
 *   same `camera-settled` observation a drag is; an action on the cameras
 *   pressed while its glide goes on (O right after W) ends the gesture there,
 *   and neither ever leaves a "Changed outside the history" step.
 * - Every global key shortcut either records exactly one step (a new one, or
 *   the camera step it extends) or changes nothing the state fingerprint
 *   covers; a chord with Ctrl, ⌘ or Alt, a key no shortcut uses and words
 *   typed with the plot focused record nothing beyond that.
 * - Ctrl/Cmd+Z pressed right after a camera drag undoes the drag.
 * - Choosing a selection tool is no step (an input mode, page chrome), so
 *   one lasso is one step and one undo.
 * - On a phone (390 px) the sheet opening and closing (the peek bar, its ✕,
 *   the H key) is page chrome: nothing in the history and nothing the
 *   fingerprint covers changes. Undo pressed inside the sheet never closes
 *   it, even when it undoes a step that hid the sidebar.
 *
 * After every key the page is waited on until it is still (the dispatcher
 * and the history idle, the camera at rest, the fingerprint and the history
 * agreeing twice, two frames apart), never for a time.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;

function productErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error' || (message.type() === 'warning' && message.text().startsWith('[history]'))) {
      errors.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  await waitForPageAtRest(page);
  return settle(page);
}

/**
 * Wait until the page is still and say what it shows: the state
 * fingerprint, what the history shows, its steps (id, type, label) and its
 * head with what the head holds.
 */
function settle(page) {
  return page.evaluate(async () => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    let last = null;
    let agreed = 0;
    for (let round = 0; round < 600; round++) {
      const history = window._cellucidHistories.current();
      await getActions().idle();
      await history.idle();
      await frame();
      await frame();
      const tree = history.active;
      const facts = {
        fingerprint: (await stateFingerprint(getStateDomains())).domains,
        shown: history.shownHashes(),
        steps: [...tree.steps.values()].map(step => ({ id: step.id, type: step.type, label: step.label })),
        head: tree.headId,
        headAfter: JSON.stringify(tree.steps.get(tree.headId).after),
      };
      const moving = window._cellucidViewer.isCameraInMotion();
      const key = JSON.stringify(facts);
      agreed = !moving && key === last ? agreed + 1 : 0;
      if (agreed >= 2) return facts;
      last = key;
    }
    throw new Error('the page never stood still');
  });
}

/** The domains whose value differs from what the history shows: changed with no step. */
function drifted(facts) {
  return Object.keys(facts.fingerprint).filter(id => facts.shown[id] !== facts.fingerprint[id]);
}

function changedDomains(before, after) {
  return Object.keys(after.fingerprint).filter(id => before.fingerprint[id] !== after.fingerprint[id]);
}

function outsideSteps(facts) {
  return facts.steps.filter(step => step.type === 'history.outside-change').map(step => step.id);
}

/**
 * What one key did to the history: 'nothing', 'one step' (new, or the head
 * extended: a camera step that goes on), or a sentence that names what is
 * wrong.
 */
function verdict(before, after) {
  const problems = [];
  if (outsideSteps(after).length > 0) problems.push(`a change made outside the history was kept (${outsideSteps(after).join(', ')})`);
  if (drifted(after).length > 0) problems.push(`${drifted(after).join(', ')} changed with no step`);
  const changed = changedDomains(before, after);
  const added = after.steps.length - before.steps.length;
  const extended = added === 0 && after.head === before.head && after.headAfter !== before.headAfter;
  if (changed.length === 0 && (added !== 0 || after.head !== before.head)) problems.push(`nothing changed, yet the history moved (${added} steps added)`);
  if (changed.length > 0 && !(added === 1 || extended)) problems.push(`${changed.join(', ')} changed with ${added} steps added`);
  if (problems.length > 0) return problems.join('; ');
  return changed.length === 0 ? 'nothing' : 'one step';
}

const newTypes = (before, after) => after.steps.slice(before.steps.length).map(step => step.type);

test.describe('keys and chrome in the history', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'the keyboard walk runs on Chromium');

  test('a keyboard camera gesture is one camera step, through the same observation as a drag, and never a change outside the history', async ({ page }) => {
    const errors = productErrors(page);
    const start = await openDataset(page);
    expect(await page.evaluate(() => window._cellucidViewer.getNavigationMode())).toBe('planar');
    await page.locator('#glcanvas').focus();
    const camera = () => page.evaluate(() => JSON.stringify(window._cellucidViewer.getViewCameraState('live')));
    const before = await camera();

    // W, A, D and S held in turn, each until the camera moved: one gesture, one step.
    for (const key of ['w', 'a', 'd', 's']) {
      const from = await camera();
      await page.keyboard.down(key);
      await expect.poll(camera).not.toBe(from);
      await page.keyboard.up(key);
    }
    const moved = await settle(page);
    expect(await camera()).not.toBe(before);
    expect(verdict(start, moved)).toBe('one step');
    expect(newTypes(start, moved)).toEqual(['camera.set']);
    const gesture = moved.steps.at(-1);
    expect(gesture.label).toBe('Moved the camera of View 1');

    // A zoom key's easing and the glide it leaves are the same gesture again.
    const from = await camera();
    await page.keyboard.down('Equal');
    await expect.poll(camera).not.toBe(from);
    await page.keyboard.up('Equal');
    const zoomed = await settle(page);
    expect(verdict(moved, zoomed)).toBe('one step');

    // O pressed while the glide W left goes on: the gesture ends there and is
    // recorded first, then the navigation mode is one step of its own.
    const gliding = await camera();
    await page.keyboard.down('w');
    await expect.poll(camera).not.toBe(gliding);
    await page.keyboard.up('w');
    expect(await page.evaluate(() => window._cellucidViewer.isCameraInMotion())).toBe(true);
    await page.keyboard.press('o');
    const switched = await settle(page);
    expect(outsideSteps(switched)).toEqual([]);
    expect(drifted(switched)).toEqual([]);
    expect(newTypes(zoomed, switched)).toEqual(['camera.navigation.set']);
    expect(switched.steps.at(-2).type).toBe('camera.set');
    expect(switched.steps.at(-2).id).toBe(zoomed.head);
    expect(switched.headAfter).not.toBe(zoomed.headAfter);
    expect(errors).toEqual([]);
  });

  test('Ctrl/Cmd+Z pressed right after a camera drag undoes the drag, not the step before it', async ({ page }) => {
    // From the history hunt (gestures): the drag is recorded only once its
    // camera settles, so an undo pressed at once moved the history first
    // and the drag became a branch. The history ends a gesture still
    // settling before it moves (the dispatcher's settlers).
    const errors = productErrors(page);
    await openDataset(page);
    // The step before the drag (the dataset opens colored by cell_type, its first coloring: score is a step).
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('color.by', { field: { source: 'obs', key: 'score' } });
    });
    const before = await settle(page);
    const centre = await page.evaluate(() => {
      const rect = document.getElementById('glcanvas').getBoundingClientRect();
      const pane = window._cellucidViewer.getPresentedLayout().panes[0];
      return { x: rect.left + pane.visibleCssLeft + pane.visibleCssWidth / 2, y: rect.top + pane.visibleCssTop + pane.visibleCssHeight / 2 };
    });
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 120, centre.y + 40, { steps: 8 });
    await page.mouse.up();
    // The person presses undo at once, as soon as the mouse is up.
    await page.keyboard.press('ControlOrMeta+z');
    const after = await settle(page);
    // The drag is undone, the coloring stays, and no branch was made.
    expect(after.head).toBe(before.head);
    expect(after.fingerprint).toEqual(before.fingerprint);
    expect(after.steps.map(step => step.type)).toEqual([...before.steps.map(step => step.type), 'camera.set']);
    expect(outsideSteps(after)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('choosing a selection tool is no step: one lasso is one step, and one undo gives back the state before the tool was chosen', async ({ page }) => {
    // From the history hunt (gestures): the tool was a setting, so a lasso
    // took two undos. A tool, like Select mode, is an input mode.
    const errors = productErrors(page);
    const start = await openDataset(page);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();
    await expect(page.locator('#highlight-mode-lasso')).toHaveAttribute('aria-pressed', 'true');
    const armed = await settle(page);
    expect(verdict(start, armed)).toBe('nothing');
    const pane = await page.evaluate(() => {
      const rect = document.getElementById('glcanvas').getBoundingClientRect();
      const { visibleCssLeft, visibleCssTop, visibleCssWidth, visibleCssHeight } = window._cellucidViewer.getPresentedLayout().panes[0];
      return { left: rect.left + visibleCssLeft, top: rect.top + visibleCssTop, width: visibleCssWidth, height: visibleCssHeight };
    });
    const at = (fx, fy) => [pane.left + pane.width * fx, pane.top + pane.height * fy];
    await page.mouse.move(...at(0.1, 0.1));
    await page.keyboard.down('Alt');
    await page.mouse.down();
    for (const [fx, fy] of [[0.9, 0.1], [0.9, 0.9], [0.1, 0.9], [0.1, 0.1]]) await page.mouse.move(...at(fx, fy), { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.locator('#lasso-confirm-btn').click();
    const lassoed = await settle(page);
    expect(verdict(armed, lassoed)).toBe('one step');
    expect(newTypes(armed, lassoed)).toEqual(['highlight.cells']);
    await page.evaluate(() => window._cellucidHistories.current().undo());
    const undone = await settle(page);
    expect(undone.head).toBe(start.head);
    expect(undone.fingerprint).toEqual(start.fingerprint);
    expect(errors).toEqual([]);
  });

  test('every global key shortcut records exactly one step or changes nothing the fingerprint covers', async ({ page }) => {
    const errors = productErrors(page);
    let facts = await openDataset(page);
    await page.locator('#glcanvas').focus();
    // Each shortcut in turn (H and F twice, so the page ends as it began),
    // the movement and zoom keys (each one gesture), keys no shortcut uses,
    // and chords.
    const keys = [
      'h', 'h', '1', '2', '3', 'Shift+Slash', 'x', 'o', 'p', 'g', 'o', 'r',
      'w', 'a', 's', 'd', 'Equal', 'Minus', 'BracketLeft', 'BracketRight',
      // Q and E move only a free-flying camera.
      'g', 'q', 'e', 'o', 'Shift',
      'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'k', 'z', 'Space',
      'Control+h', 'Control+o', 'Control+1', 'Alt+p', 'Meta+g', 'Meta+x',
      'p', 'r', 'f', 'f',
    ];
    const moving = new Set(['w', 'a', 's', 'd', 'q', 'e', 'Equal', 'Minus', 'BracketLeft', 'BracketRight']);
    const camera = () => page.evaluate(() => JSON.stringify(window._cellucidViewer.getViewCameraState('live')));
    const outcomes = [];
    for (const key of keys) {
      if (moving.has(key)) {
        // A movement key is held until the camera moved (a press shorter
        // than a frame moves nothing).
        const from = await camera();
        await page.keyboard.down(key);
        await expect.poll(camera).not.toBe(from);
        await page.keyboard.up(key);
      } else {
        await page.keyboard.press(key);
      }
      // ? moves focus to the Keyboard shortcuts panel's header (that is what
      // it is for), where Space would fold the panel: the rest are pressed on
      // the plot again, as a person clicks back on it.
      if (key === 'Shift+Slash') await page.locator('#glcanvas').focus();
      const after = await settle(page);
      outcomes.push(`${key}: ${verdict(facts, after)}${newTypes(facts, after).length ? ` (${newTypes(facts, after).join(', ')})` : ''}`);
      facts = after;
    }
    await page.evaluate(() => (document.fullscreenElement ? document.exitFullscreen() : null));
    const wrong = outcomes.filter(line => !/: (nothing|one step)( \(|$)/.test(line));
    expect(wrong, outcomes.join('\n')).toEqual([]);
    // What the shortcuts are for did happen: the sidebar hidden and shown,
    // the navigation modes chosen, the help section opened, the camera moved
    // and reset.
    const steps = facts.steps.map(step => step.type);
    for (const type of ['layout.sidebar.show', 'camera.navigation.set', 'layout.section.open', 'camera.set', 'camera.reset']) {
      expect(steps, outcomes.join('\n')).toContain(type);
    }
    expect(outcomes.filter(line => /^(Control|Alt|Meta)\+/.test(line) || /^(Arrow\w+|k|z|Space|Shift):/.test(line))
      .every(line => line.endsWith(': nothing')), outcomes.join('\n')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('words typed with the plot focused record only what their shortcut letters do, and nothing outside the history', async ({ page }) => {
    const errors = productErrors(page);
    const start = await openDataset(page);
    await page.locator('#glcanvas').focus();
    await page.keyboard.type('Without alpha');
    const typed = await settle(page);
    expect(outsideSteps(typed)).toEqual([]);
    expect(drifted(typed)).toEqual([]);
    // H hid and showed the sidebar, O and P chose the navigation mode; W and
    // A may have moved the camera. Nothing else.
    const types = newTypes(start, typed);
    expect(types.filter(type => type === 'layout.sidebar.show')).toHaveLength(2);
    expect(types.filter(type => type === 'camera.navigation.set')).toHaveLength(2);
    expect(types.every(type => ['layout.sidebar.show', 'camera.navigation.set', 'camera.set'].includes(type)), types.join(', ')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('on a phone the sheet opening and closing is not history, and Undo inside the sheet keeps it open', async ({ page }) => {
    const errors = productErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const start = await openDataset(page);
    const sidebar = page.locator('#sidebar');
    const bar = page.locator('#phone-sheet-bar');
    await expect(sidebar).toHaveClass(/\bhidden\b/);
    await expect(bar).toBeVisible();

    // Opened from the peek bar, closed with its ✕, opened and closed with H.
    await bar.click();
    await expect(sidebar).not.toHaveClass(/\bhidden\b/);
    const opened = await settle(page);
    expect(verdict(start, opened)).toBe('nothing');
    await page.locator('#sidebar-toggle').click();
    await expect(sidebar).toHaveClass(/\bhidden\b/);
    const closed = await settle(page);
    expect(verdict(opened, closed)).toBe('nothing');
    await page.locator('#glcanvas').focus();
    await page.keyboard.press('h');
    await expect(sidebar).not.toHaveClass(/\bhidden\b/);
    const reopened = await settle(page);
    expect(verdict(closed, reopened)).toBe('nothing');

    // A step taken in the sheet, then Undo in the sheet: the step is undone
    // and the sheet stays open. (The dataset opens colored by cell_type, its first coloring: score is a step.)
    await page.locator('#continuous-field').selectOption({ label: 'score' });
    const colored = await settle(page);
    expect(newTypes(reopened, colored)).toEqual(['color.by']);
    const undo = page.locator('#history-undo-btn');
    await undo.click();
    const undone = await settle(page);
    expect(undone.head).toBe(reopened.head);
    expect(undone.fingerprint).toEqual(reopened.fingerprint);
    await expect(sidebar).not.toHaveClass(/\bhidden\b/);

    // Hiding the sidebar (an agent's or a notebook's action) is a layout step
    // that leaves the sheet as it is; undoing it in the sheet keeps it open.
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('layout.sidebar.show', { shown: false });
    });
    const hid = await settle(page);
    expect(newTypes(undone, hid)).toEqual(['layout.sidebar.show']);
    await expect(sidebar).not.toHaveClass(/\bhidden\b/);
    await undo.click();
    const unhid = await settle(page);
    expect(unhid.fingerprint).toEqual(undone.fingerprint);
    await expect(sidebar).not.toHaveClass(/\bhidden\b/);

    // Closed with ✕ and opened from the bar again: still nothing.
    await page.locator('#sidebar-toggle').click();
    await expect(sidebar).toHaveClass(/\bhidden\b/);
    await bar.click();
    await expect(sidebar).not.toHaveClass(/\bhidden\b/);
    expect(verdict(unhid, await settle(page))).toBe('nothing');
    expect(errors).toEqual([]);
  });
});
