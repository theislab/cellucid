/**
 * Code-load failure watch (classic script, runs before the module graph).
 *
 * The application is one ES-module graph rooted at `main.js`, and every
 * startup failure surface lives inside that graph. The page's boot script
 * (index.html, CELLUCID_PAGE_BOOT) imports the graph's entry once the
 * document is parsed: the sources on this machine, the page bundle anywhere
 * else. The import fails when one of the graph's files fails to download (a
 * dropped connection, a proxy refusal), to parse, to link (an import of an
 * export its dependency does not have: the shape of files from two deploys
 * meeting in one page), or when one throws while it is evaluated; nothing of
 * the graph runs then. The boot script hands that failure here as a
 * `cellucid-code-load-failed` event. Without this watch the page shows its
 * "Starting Cellucid" status forever.
 *
 * The page's stylesheet is the same case: the boot script does not start the
 * code in a page whose stylesheet did not load (index.html,
 * CELLUCID_STYLE_GATE), and hands that here as the same event, marked
 * `stylesheet`. The failure screen is then plain markup, and still says what
 * happened and offers the reload.
 *
 * This file is loaded directly from `index.html` (not bundled) and has no
 * dependencies, so it cannot share the failure of the graph it watches. A
 * file that did not download is told apart from code that could not run by
 * the error the import rejects with: each engine rejects a failed fetch of a
 * module with a TypeError whose message says the module did not load
 * (`FETCH_FAILURE`); a parse or link failure is a SyntaxError, and any other
 * error is the graph's own.
 *
 * It says so in the Open data status line and on the startup failure screen,
 * then asks the server which build it serves now: when that is not this
 * page's build, the page was loaded across an update and the screen says to
 * reload it.
 *
 * A page being left stops the loads it still has going, and WebKit fails
 * each as the navigation starts, before the page hides: a page reloaded
 * while its code loads would show this screen as it goes. From
 * `beforeunload` (the first thing every engine says when the page is
 * navigated away from) a failure is held until the page hides (left: nothing
 * said) or shows it stays (a key or a pointer pressed on it, back from the
 * back/forward cache, or a navigation the browser reports failed: said), as `app/app-code.js` holds the parts loaded
 * later; this file imports nothing, so it watches for itself.
 */
(() => {
  const statusId = 'data-source-status';
  const root = document.documentElement;
  const BUILD_ID_META = /<meta\s+name="cellucid-web-build-id"\s+content="([^"]+)"/;

  // Only which parameter is present is read, never its value.
  const sourceType = () => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('remote')) return 'remote';
    if (params.has('data')) return 'link';
    const source = params.get('source');
    return [
      'local-demo', 'local-user', 'remote', 'link', 'jupyter',
    ].includes(source) ? source : 'local-demo';
  };

  const MESSAGES = {
    download: {
      status:
        'Cellucid could not load its code: a request for one of its files failed. ' +
        'Check the network connection, then reload this page.',
      title: 'Cellucid could not load',
      sentence: 'A file Cellucid needs did not download. Check your connection, then try again.',
      action: 'Try again',
    },
    run: {
      status:
        'Cellucid could not run its code: one of its files does not fit the others. ' +
        'Reload this page.',
      title: 'Cellucid could not load',
      sentence:
        'Part of Cellucid’s code could not run. Reload the page; if this keeps happening, report it.',
      action: 'Reload',
    },
    updated: {
      status:
        'Cellucid has been updated: this page holds files of the previous version. ' +
        'Reload this page to open the current version.',
      title: 'Cellucid has been updated',
      sentence:
        'This page was loading while a new version of Cellucid was published, so its files ' +
        'do not fit together. Reload to open the current version.',
      action: 'Reload',
    },
  };

  // Chromium: "Failed to fetch dynamically imported module: <url>"; Firefox:
  // "error loading dynamically imported module: <url>"; WebKit: "Importing a
  // module script failed."
  const FETCH_FAILURE = /dynamically imported module|importing a module script failed/i;

  let failed = false;

  function fail(kind, detail) {
    if (failed || root.dataset.codeLoadFailed === 'true') return;
    failed = true;
    root.dataset.codeLoadFailed = 'true';
    // The module graph, and with it the analytics modules, never ran. The
    // production bootstrap's gtag still queues this one event, declared as
    // `startup_failure` in analytics/schema.js.
    if (
      window.cellucidAnalyticsEnabled === true &&
      typeof window.gtag === 'function'
    ) {
      window.gtag('event', 'startup_failure', {
        startup_phase: 'code-load',
        source_type: sourceType(),
        error_code: 'CODE_LOAD_FAILED',
        error_name: 'Error',
      });
    }
    publish(kind, detail);
    void askForDeployedBuild().then(deployed => {
      const page = document.querySelector('meta[name="cellucid-web-build-id"]')?.content;
      if (deployed !== null && page !== undefined && deployed !== page) {
        publish('updated', detail);
      }
    });
  }

  // The build the server answers for this page's address now, or null when
  // it cannot be read (no connection, a page without the build stamp).
  function askForDeployedBuild() {
    return fetch(location.pathname, { cache: 'no-store', credentials: 'same-origin' })
      .then(response => (response.ok ? response.text() : ''))
      .then(html => BUILD_ID_META.exec(html)?.[1] ?? null)
      .catch(() => null);
  }

  function publish(kind, detail) {
    const message = MESSAGES[kind];
    const status = document.getElementById(statusId);
    if (status !== null) {
      status.classList.remove('loading');
      status.classList.add('error');
      status.setAttribute('role', 'alert');
      status.textContent = message.status;
    }
    showFailureScreen(kind, message, detail);
  }

  // Whether the page is being left, and the failure held meanwhile.
  let leaving = false;
  let held = null;
  const stays = () => {
    if (!leaving) return;
    leaving = false;
    const say = held;
    held = null;
    say?.();
  };
  window.addEventListener('beforeunload', () => { leaving = true; });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    leaving = true;
    held = null;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) stays();
  });
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, stays, { capture: true });
  window.navigation?.addEventListener('navigateerror', stays);

  window.addEventListener('cellucid-code-load-failed', event => {
    const detail = event.detail;
    if (leaving) held = () => sayLoadFailure(detail);
    else sayLoadFailure(detail);
  });

  function sayLoadFailure(detail) {
    const { entry, error, stylesheet } = detail ?? {};
    if (stylesheet === true) {
      fail('download', `Cellucid's stylesheet (${entry} or one it imports) did not download.`);
      return;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (error instanceof TypeError && FETCH_FAILURE.test(error.message)) {
      fail('download', `A file of Cellucid's code (${entry} or one it imports) did not download. ${message}`);
    } else {
      fail('run', message);
    }
  }

  // The startup failure screen of app/startup-failure.js, which never loaded:
  // the brand card (components/_welcome.css) over the app (layouts/_page.css),
  // with the same parts in the same order. Nothing of the app can run, so
  // this is the whole page until it is reloaded.
  function showFailureScreen(kind, message, detail) {
    // This script runs in <head>: a failure reported before <body> exists
    // has only the status line, which the body brings with it.
    if (!document.body) return;
    document.getElementById('cellucid-startup-failure')?.remove();
    const make = (tagName, className, text) => {
      const node = document.createElement(tagName);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const surface = make('section', 'page-screen page-screen-fixed');
    surface.id = 'cellucid-startup-failure';
    surface.setAttribute('data-failure', 'code');
    surface.setAttribute('data-code-failure', kind);
    surface.setAttribute('role', 'alert');
    surface.setAttribute('aria-labelledby', 'cellucid-startup-failure-title');
    surface.tabIndex = -1;
    const card = make('div', 'welcome-content');
    const header = make('div', 'welcome-header');
    const logo = make('img', 'welcome-logo');
    logo.src = 'assets/img/cellucid-logo.svg';
    logo.alt = 'Cellucid';
    logo.width = 260;
    logo.height = 80;
    header.append(logo);
    const body = make('div', 'welcome-body');
    const title = make('h1', 'welcome-title', message.title);
    title.id = 'cellucid-startup-failure-title';
    const sentence = make('p', 'welcome-intro', message.sentence);
    const actions = make('div', 'welcome-actions');
    const retry = make('a', 'welcome-btn welcome-btn-primary');
    retry.href = location.pathname + location.search;
    const icon = make('span', 'welcome-btn-icon', '↻');
    icon.setAttribute('aria-hidden', 'true');
    const text = make('span', 'welcome-btn-text');
    text.append(make('span', 'welcome-btn-title', message.action));
    retry.append(icon, text);
    actions.append(retry);
    const details = make('details', 'welcome-details');
    details.append(
      make('summary', '', 'Details'),
      make('p', 'welcome-details-text', detail)
    );
    const links = make('ul', 'welcome-links');
    links.setAttribute('aria-label', 'Help');
    const item = make('li');
    const guide = make('a', '', 'Troubleshooting');
    guide.href = 'https://docs.cellucid.com/en/latest/user_guide/web_app/q_troubleshooting_index/index.html';
    item.append(guide);
    links.append(item);
    body.append(title, sentence, actions, details, links);
    card.append(header, body);
    surface.append(card);
    for (const sibling of Array.from(document.body.children)) sibling.inert = true;
    document.body.append(surface);
    surface.focus();
  }
})();
