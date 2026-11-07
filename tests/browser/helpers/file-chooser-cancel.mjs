/**
 * The `cancel` Playwright's Firefox fires on a file input whose chooser a
 * spec intercepts, before the spec has chosen anything.
 *
 * A file input fires `cancel` when the person dismisses its picker without
 * choosing, and `change` when they choose (HTML: "show the picker, if
 * applicable"); one picker, one of the two. The session picker
 * (`pickSessionFile`, `app/session/session-serializer.js`) settles on the
 * first: dismissed, the load is over.
 *
 * Playwright's Firefox build r1560 (microsoft/playwright#43369, in 1.65;
 * Firefox 159) intercepts a file chooser with a replacement
 * `@mozilla.org/filepicker;1` (`FilePickerOverride`, juggler
 * `TargetRegistry.js`) whose `open` answers `callback.done(returnCancel)` at
 * once, as a dismissed picker does; Firefox's input then fires a trusted
 * `cancel`, and `fileChooser.setFiles` later sets the files and fires
 * `input` and `change`. Up to 1.64 (r1538, Firefox 153) a docShell flag
 * stopped the input before any picker opened, and nothing fired before
 * `change`, as in Chromium and WebKit, then and now. Measured, a fresh
 * `<input type=file>` clicked, its chooser intercepted, a file set:
 * Firefox 159 `cancel` 14 ms after the click, then `input`, `change`;
 * Firefox 153, Chromium 158, WebKit 27.2: `input`, `change`. The session
 * picker settled on that `cancel`, and every spec that loaded a session
 * file through Load… › Open a session file… saw nothing loaded.
 *
 * In a person's Firefox the picker is the real one and `cancel` means they
 * dismissed it: nothing for the application to change. Under Playwright no
 * person dismisses a picker, so on Firefox a trusted `cancel` on a file input
 * is that emulation's alone, and is stopped here, on the window, in the
 * capture phase, before any listener of the page hears it. A page's own
 * synthetic `cancel` (untrusted) still reaches it.
 *
 * Firefox's own picker, where a run would create one, answers `cancel` at
 * once as well (`widget.disable_file_pickers`, `playwright.config.mjs`,
 * which says when Playwright's Firefox creates it for an intercepted
 * chooser); that `cancel` is stopped here the same way.
 */

/** Contexts handled already: the fixture meets a test's own context twice. */
const handled = new WeakSet();

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} browserName
 */
export async function ignoreEmulatedFileChooserCancel(context, browserName) {
  if (browserName !== 'firefox' || handled.has(context)) return;
  handled.add(context);
  await context.addInitScript(() => {
    window.addEventListener('cancel', event => {
      const target = event.target;
      if (event.isTrusted && target instanceof HTMLInputElement && target.type === 'file') {
        event.stopImmediatePropagation();
      }
    }, { capture: true });
  });
}
