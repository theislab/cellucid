/**
 * Trusted pointer input whose coordinates are not finite numbers.
 *
 * WebKit runs, four tests in 750 (2026-11-07 audit, macOS, Playwright 1.65,
 * WebKit r2388), failed on a page error no Cellucid code raised:
 * "TypeError: The provided value is non-finite at elementsFromPoint at
 * expectHitTarget at listener". Those frames are Playwright's injected hit
 * check (`setupHitTargetInterceptor`): while a click or tap runs, its
 * capture listener on the window hands the first trusted `pointerdown`,
 * `pointerup`, `click` (or `touchstart`'s first touch) it hears to
 * `elementsFromPoint(event.clientX, event.clientY)`, which throws for NaN or
 * an infinity. It skips untrusted events, so no event a page dispatches
 * itself can reach it (Cellucid constructs no mouse, pointer or touch event),
 * only the browser's own. And only a pointer event or a touch can carry such
 * a value: WebKit exposes their coordinates as unclamped doubles since its
 * fractional coordinates (WebKit 8dc5033bb0, bug 133180), while a
 * MouseEvent's are clamped to finite values (`MouseRelatedEvent::clientX`,
 * `finiteValue`). Repeated in about 310 WebKit tests (the failed specs,
 * 30 of them each the first of a new browser process, partly beside another
 * browser run), it did not happen again.
 *
 * So every context is watched for the event itself: a failed test names
 * each trusted pointer event or touch it was handed with a coordinate that
 * is not a finite number (`annotateNonFinitePointerEvents`), which is what
 * tells the browser's input apart from anything a spec or the page did.
 */

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
    const description = `${page.url()}: the browser handed the page trusted pointer input with coordinates that are not finite numbers (not Cellucid's code; Playwright's hit check throws on it): ${seen.join('; ')}`;
    testInfo.annotations.push({ type: 'non-finite-pointer-event', description });
    console.log(`[non-finite-pointer-event] ${testInfo.title} -> ${description}`);
  }
}
