import { expect } from '@playwright/test';

/**
 * Choose files in a file input, as a person can: once it is enabled.
 *
 * The data-source inputs ship `disabled` and are enabled when the listener
 * that opens what is chosen exists (`publishDataSourceReadiness` in
 * `ui-coordinator.js`). Playwright's `setInputFiles` does not wait for an
 * input to be enabled: it assigns the files to a disabled input too, and
 * nothing opens them, so a spec that chose a file before the page could take
 * it waited for a dataset that never came.
 *
 * @param {import('@playwright/test').Locator} input
 * @param {Parameters<import('@playwright/test').Locator['setInputFiles']>[0]} files
 */
export async function chooseFiles(input, files) {
  await expect(input).toBeEnabled();
  await input.setInputFiles(files);
}
