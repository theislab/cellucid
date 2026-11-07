/**
 * Console warnings an engine writes about its own implementation, on every
 * page that uses a standard API the ordinary way: a spec that fails on any
 * console warning skips these, and only these, by their exact text.
 *
 * Firefox 159 (Playwright 1.65) warns once per document
 *
 *   The execution of microtasks on this page was reordered to avoid unsafe
 *   execution.
 *
 * whenever `Promise::MaybeSafeResolve` defers a resolution because the value
 * could run page code (a callable `then`, an accessor, a proxy:
 * `RequiresDeferredPromiseResolution` in `js/src/builtin/Promise.cpp`). Bug
 * 2071285 routed the streams' internal resolutions through it on every
 * channel, and bug 2076900 added the warning
 * (https://bugzilla.mozilla.org/show_bug.cgi?id=2071285,
 * https://bugzilla.mozilla.org/show_bug.cgi?id=2076900; meta bug 2033912,
 * "Thenable Curtailment"). Gecko's own TransformStream hands its readable and
 * writable sides a start algorithm that returns the transform's start
 * promise, a native Promise, so constructing any TransformStream on a window
 * emits it: `new TransformStream()`, `new CompressionStream('gzip')`, `new
 * DecompressionStream('gzip')`, `new TextDecoderStream()`. Nothing the page
 * writes is involved, and Mozilla's page for the warning says it needs no
 * action (dom/docs/promise/safe-promise-resolve.md). Workers never show it:
 * it is reported only to a window's document. In Cellucid it comes from the
 * session codec's native gzip (`assets/js/app/session/codecs/gzip.js`) on
 * Save and on opening a session. `engine-console.spec.mjs` keeps the claim
 * true: it fails when a Firefox no longer warns on a bare TransformStream,
 * which is when this exception goes.
 */
const FIREFOX_SAFE_RESOLVE_REORDERING = /^\[JavaScript Warning: "The execution of microtasks on this page was reordered to avoid unsafe execution\." \{file: "([^"]*)" line: 0\}\]$/;

/**
 * Whether a console message is Firefox's own safe-resolve reordering warning:
 * its exact text, located where the engine reports it, at the first line of
 * the document it names. A page's own `console.warn` is located at its script
 * (an inline script of `index.html` could only share that place by starting
 * on the doctype's line).
 *
 * @param {import('@playwright/test').ConsoleMessage} message
 * @returns {boolean}
 */
export function isFirefoxSafeResolveReorderingWarning(message) {
  if (message.type() !== 'warning') return false;
  if (message.page()?.context().browser()?.browserType().name() !== 'firefox') return false;
  const match = FIREFOX_SAFE_RESOLVE_REORDERING.exec(message.text());
  if (match === null) return false;
  const { url, lineNumber } = message.location();
  return url === match[1] && lineNumber === 0;
}
