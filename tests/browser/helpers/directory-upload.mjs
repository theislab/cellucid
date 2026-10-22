/**
 * Choose a directory in a `webkitdirectory` file input.
 *
 * Playwright's directory `setInputFiles` waits for the input's `input` event,
 * but through 1.64 it installs that listener without waiting for the browser
 * to acknowledge it before assigning the files
 * (microsoft/playwright#43367, fixed by #43385 for 1.65). When the event wins
 * the race the files are assigned and the page loads them, yet the call never
 * returns and the test times out.
 *
 * This installs its own listener first, confirmed by the browser, then waits
 * for whichever comes first: Playwright's call or that same `input` event. A
 * failed assignment still rejects. Once the pinned Playwright includes the
 * fix, every caller becomes a plain `locator.setInputFiles(directory)`.
 *
 * @param {import('@playwright/test').Locator} input
 * @param {string} directory
 */
export async function chooseDirectory(input, directory) {
  const inputEvent = await input.evaluateHandle(node => ({
    promise: new Promise(resolve => {
      node.addEventListener('input', () => resolve(), { once: true });
    }),
  }));
  try {
    // `Promise.race` subscribes to both, so the loser -- Playwright's own wait
    // when it missed the event -- settles silently when the page closes.
    await Promise.race([
      input.setInputFiles(directory),
      inputEvent.evaluate(event => event.promise),
    ]);
  } finally {
    await inputEvent.dispose().catch(() => {});
  }
}
