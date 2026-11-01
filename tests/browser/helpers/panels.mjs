import { expect } from './test.mjs';

/**
 * Visualization, Navigation and Compare views start collapsed. A spec that
 * drives their controls opens them first, as a user does.
 */
export const COLLAPSED_BY_DEFAULT = Object.freeze([
  'visualization-section',
  'navigation-section',
  'compare-views-section',
]);

/**
 * The Session panel's collapsible sections (`ui/modules/session-sections.js`),
 * collapsed by default: Subsampling (Cells to open, Genes read for) and Data
 * mapping, by their header buttons.
 */
export const SESSION_SECTION_TOGGLES = Object.freeze({
  subsampling: 'reading-toggle',
  dataMapping: 'data-mapping-toggle',
});

/**
 * Opens one Session section, as a person does with a click on its header,
 * and returns once it is open. A click before the page bound the header
 * does nothing, so it is clicked until the header says it is open.
 *
 * @param {import('@playwright/test').Page} page
 * @param {keyof typeof SESSION_SECTION_TOGGLES} name
 */
export async function openSessionSection(page, name) {
  const toggle = page.locator(`#${SESSION_SECTION_TOGGLES[name]}`);
  await expect.poll(async () => {
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    return toggle.getAttribute('aria-expanded');
  }).toBe('true');
}

/**
 * Has every page of `page`'s context start with the Session sections open,
 * as a viewer who opened them before does (the open state is this browser's
 * preference, `localStorage`): for a spec that drives Cells to open, Genes
 * read for or the data mapping across openings and reloads, and is not
 * about the sections themselves.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function openSessionSectionsOnLoad(page) {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem('cellucid_session_sections', JSON.stringify({ subsampling: true, dataMapping: true }));
    } catch {
      // A page that keeps nothing: the spec opens the sections itself.
    }
  });
}

/** Opens Subsampling (Cells to open, Genes read for). */
export function openReadingSection(page) {
  return openSessionSection(page, 'subsampling');
}

/** Opens Data mapping. */
export function openDataMapping(page) {
  return openSessionSection(page, 'dataMapping');
}

/**
 * Opens the panels and returns once each one opened has dispatched its
 * `toggle`. That event is queued as a task, so returning right after setting
 * `open` left it pending: a listener a spec attached next (the toggle counter
 * of `panel-header-controls.spec.mjs`) could still receive it, and on macOS
 * WebKit it did, counting a toggle no control had caused.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{sessionSections?: boolean}} [options]
 */
export async function openCollapsedPanels(page, { sessionSections = true } = {}) {
  await openPhoneSheet(page);
  // The Session panel's own collapsed sections too, once its controls are
  // ready: while the opening waits on the person (a sign-in), Cellucid is
  // still starting and its headers do not open (`sessionSections: false`).
  if (sessionSections) {
    await openReadingSection(page);
    await openDataMapping(page);
  }
  await page.evaluate(ids => Promise.all(ids.map(id => {
    const section = document.getElementById(id);
    if (!(section instanceof HTMLDetailsElement)) {
      throw new Error(`#${id} is not a panel`);
    }
    if (section.open) return null;
    const toggled = new Promise(resolve => {
      section.addEventListener('toggle', resolve, { once: true });
    });
    section.open = true;
    return toggled;
  })), COLLAPSED_BY_DEFAULT);
}

/**
 * On a phone the panel starts as its peek bar (the plot comes first); a
 * spec that drives the panel's controls opens it, as a person does, with a
 * tap on the bar. Elsewhere, or once open, nothing happens.
 */
export async function openPhoneSheet(page) {
  const bar = page.locator('#phone-sheet-bar');
  if (!(await bar.isVisible())) return;
  await bar.click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/\bhidden\b/);
  // The sheet rises from the bar: what it shows, and where, is final once
  // that is over.
  await expect.poll(() => page.locator('#sidebar').evaluate(sidebar => sidebar.getAnimations().length)).toBe(0);
}

/**
 * Waits until `frame` floats and its lift is over. Undocking plays a lift
 * (`floating-enter`, `_accordion.css`): the frame scales up from 0.96 and its
 * card's shadow grows. A box or shadow read while it runs is neither what the
 * window settles to nor what is on the screen a moment later.
 *
 * @param {import('@playwright/test').Locator} frame
 */
export async function expectFloatingSettled(frame) {
  await expect(frame).toHaveClass(/\baccordion-floating\b/);
  await expect(frame).not.toHaveClass(/\bfloating-enter\b/);
}
