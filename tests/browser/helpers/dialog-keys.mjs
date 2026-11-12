import { expect } from '@playwright/test';

/**
 * The key that moves focus to the next control of any kind (Shift: the one
 * before). WebKit moves to buttons, links, checkboxes and other controls
 * that take no text only with Option held (Alt+Tab here), as Safari does
 * unless full keyboard access is on; plain Tab there skips from text field
 * to text field (macOS's WebKit; Linux's moves to every control), so a test
 * that means "the next control" presses this, on every engine.
 */
export function tabKey(browserName, { shift = false } = {}) {
  return `${browserName === 'webkit' ? 'Alt+' : ''}${shift ? 'Shift+' : ''}Tab`;
}

/**
 * Where Tab goes from the focused element, `count` times: each element's id
 * (or its text, or its tag), and whether it is inside `dialogSelector`. A modal `<dialog>`
 * makes the page behind it inert, so Tab moves through the dialog's controls
 * and, past the last, out of the page to the browser's own controls (`BODY`
 * here) and back in: never to a control of the page. WebKit moves through
 * buttons and links only with Option held (Alt+Tab here), as Safari does
 * unless full keyboard access is on.
 */
export async function tabWalk(page, browserName, dialogSelector, count, { shift = false } = {}) {
  const key = tabKey(browserName, { shift });
  const walk = [];
  for (let step = 0; step < count; step++) {
    await page.keyboard.press(key);
    walk.push(await page.evaluate(selector => {
      const active = document.activeElement;
      if (active === null || active === document.body) return { at: 'BODY', inside: false };
      return {
        at: active.id || active.textContent.replace(/\s+/g, ' ').trim() || active.tagName,
        inside: active.closest(selector) !== null,
      };
    }, dialogSelector));
  }
  return walk;
}

/** Every stop is inside the dialog or the browser's own controls past it. */
export function expectContained(walk, label) {
  const outside = walk.filter(stop => !stop.inside && stop.at !== 'BODY');
  expect(outside, `${label}: Tab reached the page behind the dialog`).toEqual([]);
}

/**
 * Whether a control is out of a person's reach: in an inert subtree, or behind
 * an open modal `<dialog>` (the browser makes everything outside the topmost
 * one inert without an attribute, so the control cannot take focus). Focus
 * goes back where it was.
 */
export function outOfReach(locator) {
  return locator.evaluate(element => {
    if (element.closest('[inert]') !== null) return true;
    const before = document.activeElement;
    element.focus({ preventScroll: true });
    const reached = document.activeElement === element;
    if (reached && before instanceof HTMLElement) before.focus({ preventScroll: true });
    return !reached;
  });
}
