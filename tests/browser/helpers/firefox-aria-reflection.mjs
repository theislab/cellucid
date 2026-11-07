/**
 * Firefox (157, 159 and Nightly 162 of 2026-11-05 measured) crashes the
 * content process (SIGSEGV, a write through a null pointer) when
 * `element.ariaLabelledByElements` is read in two JS worlds: Mozilla bug
 * 2090055
 * (https://bugzilla.mozilla.org/show_bug.cgi?id=2090055). The generated
 * getter's cache flag is per world, its cached array per element, so the
 * second world's read finds the first world's array and
 * `Element::GetAttrAssociatedElementsForBindings` writes through the null
 * flag. Playwright 1.65 reads that property when it computes an accessible
 * name (`getByRole(role, { name })`), in its utility world for actions and
 * assertions and in the page's own world for `evaluate`, `evaluateAll`,
 * `allTextContents` and `dispatchEvent`
 * (https://github.com/microsoft/playwright/issues/43967). So a spec that
 * asserts on a named role locator and then evaluates one crashes the page
 * when the element has `aria-labelledby`, every Cellucid dialog's name. It
 * reproduces on a page with no script at all: Cellucid's code never reads
 * the property (`firefox-aria-reflection.spec.mjs` checks both).
 *
 * In Firefox, the page's world answers `ariaLabelledByElements` with
 * `null`, so only the utility world reaches Gecko's getter; Playwright then
 * reads the `aria-labelledby` ids itself, which is how every Cellucid label
 * is set. The spec fails once a Firefox no longer crashes, which is when
 * this guard goes.
 */
export const FIREFOX_ARIA_REFLECTION_BUG = 'https://bugzilla.mozilla.org/show_bug.cgi?id=2090055';

/** Contexts guarded already: the fixture meets a test's own context twice. */
const guarded = new WeakSet();

/** Install the guard in every page of `context`, in Firefox. */
export async function guardFirefoxAriaReflection(context, browserName) {
  if (browserName !== 'firefox' || guarded.has(context)) return;
  guarded.add(context);
  await context.addInitScript(() => {
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'ariaLabelledByElements');
    if (native === undefined) return;
    Object.defineProperty(Element.prototype, 'ariaLabelledByElements', {
      ...native,
      get() {
        return null;
      },
    });
  });
}
