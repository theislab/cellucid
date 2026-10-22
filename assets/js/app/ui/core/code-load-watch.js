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
 * the window; it reports only module scripts of this origin.
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
    if (params.has('github')) return 'github-repo';
    const source = params.get('source');
    return [
      'local-demo', 'local-user', 'remote', 'github-repo', 'jupyter',
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
    if (status === null) return;
    status.classList.remove('loading');
    status.classList.add('error');
    status.setAttribute('role', 'alert');
    status.textContent = message;
  }, true);
})();
