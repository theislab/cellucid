/**
 * Trusted pointer input whose coordinates are not finite numbers.
 *
 * On macOS, Playwright's WebKit turns each mouse action into an `NSEvent` at a
 * point of the page's window (`platformDispatchMouseEvent`), and WebKit maps
 * that point to the page through the window's current place on the screen
 * (`WebEventFactory::createWebMouseEvent`). Every page lives in a window kept
 * off the screen (`createHeadlessPage`), and macOS moves and scales that
 * window with all the others while Mission Control opens or closes, or the
 * desktop slides from one Space to another. Input sent meanwhile reaches the
 * page somewhere else, or, in a window opened just before such a transition,
 * at NaN, NaN on `html`. Nothing a spec or the page does brings it about: a
 * page of Playwright's WebKit with nothing but a button, clicked while
 * Mission Control is opened and closed, receives the same events. What
 * causes it is a person using Mission Control or switching Spaces on the
 * machine while WebKit runs, which never happens on a hosted runner.
 *
 * A misplaced click usually costs Playwright a retry (its hit check finds
 * `html`). A non-finite one makes that check itself throw: while a click or
 * tap runs, Playwright's capture listener on the window
 * (`setupHitTargetInterceptor`) hands the first trusted `pointerdown`,
 * `pointerup` or `click` (or `touchstart`'s first touch) it hears to
 * `elementsFromPoint(event.clientX, event.clientY)`, which throws "The
 * provided value is non-finite", and a spec that collects page errors fails
 * on it. Only a pointer event or a touch can carry such a value: WebKit keeps
 * their coordinates as unclamped doubles, while a MouseEvent's are clamped to
 * finite values (`MouseRelatedEvent::clientX`, `finiteValue`).
 *
 * So every context is watched for the event itself: a failed test names each
 * trusted pointer event or touch it was handed with a coordinate that is not
 * a finite number (`annotateNonFinitePointerEvents`), which tells the
 * browser's input apart from anything a spec or the page did.
 *
 * Input that lands somewhere else at finite coordinates leaves no such mark
 * in the page: a press and its release fall on two elements, a lasso is
 * drawn off the plot, the pointer leaves what it hovered, Playwright's hit
 * check finds `<html>` and clicks again. For those the system's own record
 * speaks: the Dock logs each step of Mission Control opening or closing and
 * of a slide between Spaces, and a failed WebKit test on a Mac names each
 * such transition from the test's start to its end
 * (`annotateMacWindowTransitions`).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const watched = new WeakSet();

/**
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function watchNonFinitePointerEvents(context) {
  if (watched.has(context)) return;
  watched.add(context);
  await context.addInitScript(() => {
    const seen = [];
    Object.defineProperty(window, '__cellucidNonFinitePointerEvents', { value: seen });
    const describe = element => (element instanceof Element
      ? `${element.localName}${element.id === '' ? '' : `#${element.id}`}`
      : String(element));
    for (const type of ['pointerdown', 'pointerup', 'click', 'auxclick', 'contextmenu', 'touchstart', 'touchend']) {
      window.addEventListener(type, event => {
        if (!event.isTrusted) return;
        const points = event.touches === undefined ? [event] : [...event.touches, ...event.changedTouches];
        for (const point of points) {
          if (Number.isFinite(point.clientX) && Number.isFinite(point.clientY)) continue;
          seen.push(`${type} (${event.constructor.name}${point === event ? '' : ', a touch'}) at ${point.clientX}, ${point.clientY} on ${describe(event.target)}`);
        }
      }, true);
    }
  });
}

/**
 * Name, on a failed test, the trusted pointer input each page of `context`
 * was handed with coordinates that are not finite numbers.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('@playwright/test').TestInfo} testInfo
 */
export async function annotateNonFinitePointerEvents(context, testInfo) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const seen = await page.evaluate(() => window.__cellucidNonFinitePointerEvents ?? []).catch(() => []);
    if (seen.length === 0) continue;
    const description = `${page.url()}: the browser handed the page trusted pointer input with coordinates that are not finite numbers, as macOS WebKit does while Mission Control or a change of Space moves the windows (not Cellucid's code; Playwright's hit check throws on it): ${seen.join('; ')}`;
    testInfo.annotations.push({ type: 'non-finite-pointer-event', description });
    console.log(`[non-finite-pointer-event] ${testInfo.title} -> ${description}`);
  }
}

/**
 * What the Dock logs while the windows move: each step of the gesture that
 * opens or closes Mission Control or slides to another Space ("Update system
 * control value", from 0.0 to 1.0 or back), Mission Control showing and
 * hiding the windows, and the end of a change of Space.
 */
const WINDOW_TRANSITIONS = 'process == "Dock" AND (eventMessage BEGINSWITH "Update system control value"'
  + ' OR eventMessage IN {"Showing all windows", "Hiding all windows", "Space display finished animating"})';

/** `ms` as `log show` reads a moment: local time to the second, with its offset. */
function logTime(ms) {
  const date = new Date(ms);
  const pad = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}

/**
 * Name, on a failed WebKit test on a Mac, each time macOS moved the windows
 * between `since` (ms since the epoch) and now, as the Dock logged it. Steps
 * less than a second apart are one transition, named by its first and last
 * step's local time.
 *
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} browserName
 * @param {number} since
 */
export async function annotateMacWindowTransitions(testInfo, browserName, since) {
  if (browserName !== 'webkit' || process.platform !== 'darwin') return;
  const { stdout } = await run('/usr/bin/log', [
    'show', '--style', 'ndjson', '--predicate', WINDOW_TRANSITIONS,
    '--start', logTime(since), '--end', logTime(Math.ceil(Date.now() / 1000) * 1000),
  ], { maxBuffer: Infinity });
  const transitions = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    // Each step has a time ("2026-11-13 12:28:38.485513+0100"); the last line only counts them.
    const { timestamp } = JSON.parse(line);
    if (typeof timestamp !== 'string') continue;
    const step = { at: Date.parse(`${timestamp.slice(0, 10)}T${timestamp.slice(11, 23)}${timestamp.slice(-5)}`), clock: timestamp.slice(11, 23) };
    const last = transitions.at(-1);
    if (last !== undefined && step.at - last.to.at < 1000) last.to = step;
    else transitions.push({ from: step, to: step });
  }
  if (transitions.length === 0) return;
  const description = 'macOS moved the windows while this test ran (Mission Control, or a slide to another Space, '
    + "in the Dock's log), and WebKit places input through its window's place on the screen, so input sent "
    + "meanwhile reached the page somewhere else (not Cellucid's code): "
    + transitions.map(({ from, to }) => (from === to ? from.clock : `${from.clock}–${to.clock}`)).join(', ');
  testInfo.annotations.push({ type: 'mac-window-transition', description });
  console.log(`[mac-window-transition] ${testInfo.title} -> ${description}`);
}
