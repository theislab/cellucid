/**
 * A click whose press and release fell on either side of a layout change.
 *
 * A click is a press and a release on the same element. Playwright aims a
 * click, checks what the press lands on, and releases a moment later at the
 * same point: if the page lays itself out in between (the Session panel's
 * Dataset box filling in while the start dataset opens moves everything
 * under it, the foot of the panel by hundreds of pixels), the release
 * lands on something else, the browser sends the `click` to their common
 * ancestor, and the control pressed hears nothing. No error anywhere: the
 * spec then waits a minute for what the click should have done
 * (`ui-visual-consistency.spec.mjs`, the license link; the Benchmark run
 * button of `synthetic-dataset.mjs`).
 *
 * The cure is the spec's: click once the page has stopped moving (the
 * opening over, `waitForPageAtRest`). Every context of every test is watched
 * here, so a spec that does not fails naming the cause instead of waiting
 * for a consequence: a trusted mouse press the page heard and its release at
 * the same point, the pressed element still drawn and no longer under that
 * point. A press that lands on another element than the one aimed at is
 * stopped by Playwright before the page hears it, and Playwright clicks again
 * (its hit-target check, at the first event of the click): no click was
 * split, and the page heard nothing. A drag
 * moves the pointer; an element its own press removes, hides (a menu's
 * option, chosen on the press) or covers is gone, has no box, or is still
 * under the pointer; a touch is not a mouse: none of those is reported.
 *
 * A helper that opens a control while the page may still be moving, whatever
 * the spec is about (`openSessionSection`, `panels.mjs`), takes the reports
 * of its own control (`takeSplitClicksOn`) and clicks again, as a person
 * does: a click known not to have happened, not one hoped to work this time.
 */

const found = [];
/** Reports a helper took and answered by clicking again. */
const taken = new Set();
/** Contexts watched already: the fixture meets a test's own context twice. */
const watched = new WeakSet();

/**
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function watchSplitClicks(context) {
  if (watched.has(context)) return;
  watched.add(context);
  await context.exposeBinding('__cellucidSplitClick', (_source, report) => { found.push(report); });
  await context.addInitScript(() => {
    const describe = element => {
      if (!(element instanceof Element)) return String(element);
      const id = element.id === '' ? '' : `#${element.id}`;
      const classes = typeof element.className === 'string' && element.className !== ''
        ? `.${element.className.trim().split(/\s+/).join('.')}`
        : '';
      return `${element.tagName.toLowerCase()}${id}${classes}`;
    };
    // What can move an element without the element itself changing: the
    // height of everything laid out before it in each of its ancestors, and
    // the scroll of each ancestor. Taken at the press, compared at a split
    // release, so a report names what moved (a row added to a list above, a
    // scrolled panel) instead of only that something did.
    const layoutAbove = target => {
      const boxes = new Map();
      const scrolls = new Map();
      for (let node = target; node instanceof Element && node !== document.body; node = node.parentElement) {
        for (let sibling = node.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
          boxes.set(sibling, Math.round(sibling.getBoundingClientRect().height));
        }
        const parent = node.parentElement;
        if (parent !== null && (parent.scrollTop !== 0 || parent.scrollHeight > parent.clientHeight)) scrolls.set(parent, Math.round(parent.scrollTop));
      }
      return { boxes, scrolls };
    };
    const movedAbove = before => {
      const moved = [];
      for (const [element, height] of before.boxes) {
        const now = element.isConnected ? Math.round(element.getBoundingClientRect().height) : null;
        if (now !== height) moved.push(`${describe(element)} ${height}→${now ?? 'removed'}`);
      }
      for (const [element, top] of before.scrolls) {
        const now = Math.round(element.scrollTop);
        if (now !== top) moved.push(`${describe(element)} scrolled ${top}→${now}`);
      }
      return moved;
    };
    // Kept in the page too, so a helper reads them the moment its click returns.
    window.__cellucidSplitClicks = [];
    let reports = 0;
    let press = null;
    window.addEventListener('pointerdown', event => {
      press = event.isTrusted && event.pointerType === 'mouse'
        ? { event, heard: false, target: event.target, x: event.clientX, y: event.clientY, above: layoutAbove(event.target) }
        : null;
    }, true);
    // A press Playwright's hit-target check stops on the window never reaches
    // the document: the page did not hear it.
    document.addEventListener('pointerdown', event => {
      if (press !== null && press.event === event) press.heard = true;
    }, true);
    window.addEventListener('pointerup', event => {
      const pressed = press;
      press = null;
      if (pressed === null || !pressed.heard || !event.isTrusted || event.pointerType !== 'mouse') return;
      if (event.clientX !== pressed.x || event.clientY !== pressed.y) return;
      const target = pressed.target;
      if (!(target instanceof Element) || !target.isConnected) return;
      if (event.target === target || (event.target instanceof Node && target.contains(event.target))) return;
      // Hidden by its own press (it has no box any more): it did not move.
      if (target.getClientRects().length === 0) return;
      const box = target.getBoundingClientRect();
      if (pressed.x >= box.left && pressed.x <= box.right && pressed.y >= box.top && pressed.y <= box.bottom) return;
      // The pressed element and what it is in, by id: a helper asks for the clicks on its control.
      const within = [];
      for (let node = target; node instanceof Element; node = node.parentElement) if (node.id !== '') within.push(node.id);
      const report = {
        id: `${performance.timeOrigin}:${reports++}`,
        pressed: describe(target),
        within,
        released: describe(event.target),
        at: [pressed.x, pressed.y],
        pressedNow: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)],
        moved: movedAbove(pressed.above),
        page: location.pathname,
      };
      window.__cellucidSplitClicks.push(report);
      window.__cellucidSplitClick?.(report);
    }, true);
  });
}

/**
 * Take the split clicks pressed on the element of id `control`, or on
 * anything in it (a button's label), in `page`: how many there were. The
 * caller clicks again.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} control
 * @returns {Promise<number>}
 */
export async function takeSplitClicksOn(page, control) {
  const ids = await page.evaluate(id => {
    // A page of a context made outside a test (a `beforeAll`) is not watched: it reports nothing.
    const reports = window.__cellucidSplitClicks ?? [];
    const mine = reports.filter(report => report.within.includes(id));
    window.__cellucidSplitClicks = reports.filter(report => !mine.includes(report));
    return mine.map(report => report.id);
  }, control);
  for (const id of ids) taken.add(id);
  return ids.length;
}

/** Start a test with nothing reported (a test that failed midway leaves its reports). */
export function forgetSplitClicks() {
  found.length = 0;
  taken.clear();
}

/** Fail the test in which a click was split by a layout change, naming each. */
export function expectNoSplitClicks() {
  const reports = found.splice(0).filter(report => !taken.has(report.id));
  if (reports.length > 0) {
    throw new Error(
      'A click was pressed on one element and released on another because the page moved in between; '
        + 'click once the page has stopped changing (the opening over, waitForPageAtRest):\n'
        + reports.map(report => JSON.stringify(report)).join('\n'),
    );
  }
}
