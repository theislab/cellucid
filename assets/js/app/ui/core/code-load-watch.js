/**
 * Code-load failure watch (classic script, runs before the module graph).
 *
 * The application is one ES-module graph rooted at `main.js`, and every
 * startup failure surface lives inside that graph. When one of its modules
 * fails to download (a dropped connection, a proxy refusal, a deploy that
 * replaced files mid-load), the browser abandons the whole graph and fires
 * `error` on the module script element; nothing from the graph runs, so
 * without this watch the page shows its "Starting Cellucid" status forever.
 *
 * This file is loaded directly from `index.html` (not bundled) and has no
 * dependencies, so it cannot share the failure of the graph it watches.
 * `error` on a script element does not bubble, so the listener captures it on
 * the window; it reports only module scripts of this origin. It says so in
 * the Open data status line and on the startup failure screen.
 */
(() => {
  const statusId = 'data-source-status';
  const message =
    'Cellucid could not load its code: a request for one of its files failed. ' +
    'Check the network connection, then reload this page.';

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

  window.addEventListener('error', event => {
    const target = event.target;
    if (
      !(target instanceof HTMLScriptElement) ||
      target.type !== 'module' ||
      new URL(target.src, document.baseURI).origin !== location.origin
    ) {
      return;
    }
    if (document.documentElement.dataset.codeLoadFailed === 'true') return;
    document.documentElement.dataset.codeLoadFailed = 'true';
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
    const status = document.getElementById(statusId);
    if (status !== null) {
      status.classList.remove('loading');
      status.classList.add('error');
      status.setAttribute('role', 'alert');
      status.textContent = message;
    }
    showFailureScreen(target.src);
  }, true);

  // The startup failure screen of app/startup-failure.js, which never loaded:
  // the brand card (components/_welcome.css) over the app (layouts/_page.css),
  // with the same parts in the same order. Nothing of the app can run, so
  // this is the whole page until it is reloaded.
  function showFailureScreen(failedUrl) {
    // This script runs in <head>: a failure reported before <body> exists
    // has only the status line, which the body brings with it.
    if (!document.body || document.getElementById('cellucid-startup-failure') !== null) return;
    const make = (tagName, className, text) => {
      const node = document.createElement(tagName);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const surface = make('section', 'page-screen page-screen-fixed');
    surface.id = 'cellucid-startup-failure';
    surface.setAttribute('data-failure', 'code');
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
    const title = make('h1', 'welcome-title', 'Cellucid could not load');
    title.id = 'cellucid-startup-failure-title';
    const sentence = make(
      'p',
      'welcome-intro',
      'A file Cellucid needs did not download. Check your connection, then try again.'
    );
    const actions = make('div', 'welcome-actions');
    const retry = make('a', 'welcome-btn welcome-btn-primary');
    retry.href = location.pathname + location.search;
    const icon = make('span', 'welcome-btn-icon', '\u21bb');
    icon.setAttribute('aria-hidden', 'true');
    const text = make('span', 'welcome-btn-text');
    text.append(make('span', 'welcome-btn-title', 'Try again'));
    retry.append(icon, text);
    actions.append(retry);
    const details = make('details', 'welcome-details');
    details.append(
      make('summary', '', 'Details'),
      make('p', 'welcome-details-text', `${failedUrl} did not download.`)
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
