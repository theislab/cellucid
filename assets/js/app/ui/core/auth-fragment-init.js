/**
 * Take a GitHub sign-in's answer out of the page address before anything
 * else runs.
 *
 * The Cellucid GitHub service sends the browser back to the page with the
 * sign-in's token (or its error) in the address fragment
 * (`#cellucid_github_auth=1&cellucid_github_token=…`). The module that adopts
 * it (`app/community-annotations/github-auth.js`) runs only once the module
 * graph has loaded; were it never to run (a startup that fails first), the
 * token would stay in the address bar and in that history entry. This
 * classic script in the head moves the whole fragment into the page's memory
 * (`window.cellucidGitHubAuthFragment`, read once by
 * `completeSignInFromRedirect`) and replaces the address without it, before
 * the stylesheet and the modules are even requested. The module then puts
 * back any part of the fragment that was not the sign-in's.
 */
(() => {
  const hash = window.location.hash;
  if (!/^#(?:.*&)?cellucid_github_(?:auth|token|token_expires_in|error)=/.test(hash)) return;
  Object.defineProperty(window, 'cellucidGitHubAuthFragment', {
    configurable: true,
    enumerable: false,
    value: hash,
    writable: false,
  });
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
})();
