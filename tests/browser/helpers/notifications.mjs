/**
 * What a page has said in notifications, whatever became of them. A notice
 * dismisses itself after seconds of real time, and on a slow runner a spec may
 * come to read it later than that (a replay's line, read after its report): a
 * spec about what was said reads this record.
 * Installed before the page opens.
 */
export async function recordNotifications(page) {
  await page.addInitScript(() => {
    const said = [];
    window.__saidInNotifications = said;
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('notification')) said.push(node.textContent);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/** Every notification said so far, as its text was when it appeared. */
export function saidInNotifications(page) {
  return page.evaluate(() => window.__saidInNotifications);
}
