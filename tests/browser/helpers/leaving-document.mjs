/**
 * What a document says while it is being left.
 *
 * A navigation of the page (`page.goto`, `page.reload`) stops every load the
 * document it leaves still had going: a module imported on demand, a
 * worker's module graph, a fetch. WebKit reports each stopped load as a
 * failure of that document, in its own wording ("Cannot load <url> due to
 * access control checks.", "Fetch API cannot load <url> due to access control
 * checks.", "Importing a module script failed."), and Playwright's WebKit
 * passes the fetch's, and a read of a file through a blob, as a page error
 * even where the page caught it. Chromium
 * and Firefox say nothing. They are not errors of the page: a person may
 * leave a page at any moment, and it was the test that left.
 *
 * Every page of every browser context a test opens (its own, and each a spec
 * opens with `browser.newContext()`) is prepared here
 * (`setAsideLeavingReports`, called by `helpers/test.mjs`): its navigations
 * (`goto`, `reload`, `goBack`, `goForward`) from a document mark the page as
 * leaving until they return, and while it is leaving, a console error or
 * page error in one of those wordings reaches no listener of the page. Only
 * those words, and only between the navigation's start and its return (the
 * new document's DOMContentLoaded at the earliest: no spec waits for less),
 * are set aside; any other error in that window, and every error after it,
 * still counts. They stay in the test's trace.
 *
 * The left document's lazy imports (`formats/zip/crc32.js`, a worker's
 * `formats/io/*`, the modules of the spatial-tree worker) are stopped and
 * reported within tens of milliseconds of the navigation's start, always
 * before it returns. A worker the page itself ends (`terminate()`) while its
 * modules load reports nothing (measured:
 * 38_decisions_testing_and_hosted_runners.md).
 *
 * @module helpers/leaving-document
 */

const STOPPED_BY_LEAVING = [
  /^Cannot load \S+ due to access control checks\.$/,
  /^Fetch API cannot load \S+ due to access control checks\./,
  /^Importing a module script failed\.$/,
];

/** The page's navigations that leave its document. */
const NAVIGATIONS = ['goto', 'reload', 'goBack', 'goForward'];

/** @type {WeakMap<import('@playwright/test').Page, number>} */
const leaving = new WeakMap();

/** @type {WeakSet<import('@playwright/test').Page>} */
const prepared = new WeakSet();

async function leaveDocument(page, navigation) {
  leaving.set(page, (leaving.get(page) ?? 0) + 1);
  try {
    return await navigation();
  } finally {
    const count = leaving.get(page) - 1;
    if (count === 0) leaving.delete(page);
    else leaving.set(page, count);
  }
}

/**
 * What a page error says: its message, and the first line of its stack.
 * Playwright's WebKit takes the text before a sentence's first colon for
 * the error's name and drops two characters after it, so a stopped load of
 * a `blob:` address ("Cannot load blob:http://… due to access control
 * checks.") arrives with the name "Cannot load blob" and the message
 * "ttp://… due to access control checks.", which no wording above matches;
 * the stack's first line is the sentence as WebKit said it. A page left
 * while its Stored listing read a kept file through a blob reported so
 * (`kept-gene-index.spec.mjs` meets it in WebKit).
 */
function saidBy(error) {
  const first = typeof error?.stack === 'string' ? error.stack.split('\n', 1)[0] : null;
  return first === null ? [error.message] : [error.message, first];
}

function stoppedByLeaving(page, text) {
  return leaving.has(page) && STOPPED_BY_LEAVING.some(pattern => pattern.test(text));
}

function preparePage(page) {
  if (prepared.has(page)) return;
  prepared.add(page);
  for (const name of NAVIGATIONS) {
    const navigate = page[name].bind(page);
    page[name] = (...args) => (
      page.url() === 'about:blank'
        ? navigate(...args)
        : leaveDocument(page, () => navigate(...args))
    );
  }
  // Every page listener (`page.on`, `page.waitForEvent`) hears the page's
  // events through its `emit`.
  const emit = page.emit.bind(page);
  page.emit = (event, ...args) => {
    if (event === 'console' && args[0].type() === 'error' && stoppedByLeaving(page, args[0].text())) return false;
    if (event === 'pageerror' && saidBy(args[0]).some(text => stoppedByLeaving(page, text))) return false;
    return emit(event, ...args);
  };
}

/**
 * Prepare every page of a browser context, open now or later, so that the
 * loads its navigations stop in the document they leave are not reported to
 * its listeners (module doc). A page's first navigation, from `about:blank`,
 * leaves nothing and is not marked.
 *
 * @param {import('@playwright/test').BrowserContext} context
 */
export function setAsideLeavingReports(context) {
  for (const page of context.pages()) preparePage(page);
  context.on('page', preparePage);
}
