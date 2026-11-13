/**
 * Cellucid's code cache: a service worker that keeps, in this browser, every
 * file of the app whose address names its bytes, and answers a later visit's
 * request for one from there, without asking the network.
 *
 * Why: GitHub Pages answers every file with `Cache-Control: max-age=600` and
 * the headers cannot be changed, so a visit ten minutes after the last one
 * asks the server again for each file, a round trip each, though none
 * changed. Every script and stylesheet of the app is requested at an address
 * that names its bytes (`?v=` and the first 12 hex digits of its SHA-256:
 * index.html, CELLUCID_MODULE_VERSIONS), and every file of the page and worker
 * bundles is named by its content (`assets/page/`, `assets/workers/`). Such an
 * address never names other bytes, so its file may be kept for good.
 *
 * What it answers: only GET requests of this site for files under `assets/`
 * at such an address. Everything else, the page itself and every dataset
 * request included, goes to the network as if this worker were not here
 * (where the browser allows it, without reaching this worker at all:
 * `addRoutes`).
 *
 * What it keeps, and why that is safe: a file requested at `?v=<version>` is
 * kept only when its bytes hash to that version. GitHub Pages' CDN ignores
 * the query string, so in the minutes after a deploy it may answer a new
 * version's address with the previous bytes; those are passed on and not
 * kept. A bundle file is named by its content by esbuild, or by the first 12
 * hex digits of a SHA-256 by the generator: a name only one build has, which
 * the host either has or answers with an error (not kept).
 *
 * When: the page registers it once it has loaded and names the files it
 * loaded, which it keeps then; the page is not taken over, and the next
 * visit starts under it.
 *
 * What it forgets: files are kept per build (`cellucid-code-<build id>`, the
 * build id the page's register call names). A file requested under one build
 * and kept under an earlier one is copied into the current build's cache, so
 * the files two builds share are not fetched again. When a build's worker
 * starts, the caches of every build but this one and the newest other are
 * removed: a tab still open on the previous build keeps its files.
 *
 * The page registers it only when it is a deployed site (index.html,
 * CELLUCID_PAGE_BOOT): on this machine the sources change under the page
 * and nothing is kept.
 */

const CACHE_PREFIX = 'cellucid-code-';
const BUILD = new URL(self.location.href).searchParams.get('build') ?? '';
const CACHE = `${CACHE_PREFIX}${BUILD}`;
const SCOPE = new URL(self.registration.scope);
// A file requested at the address naming its bytes.
const VERSION_QUERY = /^\?v=([0-9a-f]{12})$/;
// A file of the page bundle or a worker bundle, named by its content.
const BUNDLE_PATH = /^assets\/(?:page\/[a-z0-9-]+\.[A-Z2-7]{8}|workers\/[a-z0-9-]+\.[0-9a-f]{12})\.js$/;

self.addEventListener('install', event => {
  // Requests this worker never answers do not reach it, where the browser
  // allows it: dataset reads go straight to the network.
  if (typeof event.addRoutes === 'function' && typeof URLPattern === 'function') {
    event.waitUntil(event.addRoutes([
      {
        condition: {
          urlPattern: new URLPattern({
            protocol: SCOPE.protocol.slice(0, -1),
            hostname: SCOPE.hostname,
            port: SCOPE.port,
            pathname: `${SCOPE.pathname}assets/*`,
          }),
        },
        source: 'fetch-event',
      },
      { condition: { urlPattern: new URLPattern({}) }, source: 'network' },
    ]).catch(() => {}));
  }
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const builds = (await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE);
    // A build id begins with the date its bytes last changed: the newest
    // other is the build a tab may still be open on.
    const keep = builds.sort().at(-1);
    await Promise.all(builds.filter(name => name !== keep).map(name => caches.delete(name)));
  })());
});

// The page that registered this worker names the files it loaded (index.html,
// CELLUCID_PAGE_BOOT); each whose address names its bytes is kept now, from
// the browser's HTTP cache where it still has it, so the next visit finds it.
// All at once: a browser ends a worker whose event outlasts its limit, and
// what is not kept by then stays unkept (Firefox ends it a minute after the
// event, `dom.serviceWorkers.idle_timeout` and `idle_extended_timeout`, 30 s
// each; Chromium after 5 minutes), while one after another the files take the
// sum of their fetches.
// The page itself is not taken over: what it asks for from now on goes to the
// network as before, and the next visit starts under this worker.
self.addEventListener('message', event => {
  const urls = Array.isArray(event.data?.keep) ? event.data.keep : [];
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all([...new Set(urls)].map(href => keep(cache, href).catch(() => {})));
  })().catch(() => {}));
});

/** Keep the file at `href` when its address names its bytes and they are those bytes. */
async function keep(cache, href) {
  if (typeof href !== 'string') return;
  const address = contentAddress(new URL(href));
  if (address === null || await cache.match(href) !== undefined) return;
  const response = await fetch(href).catch(() => null);
  if (response === null || response.status !== 200 || response.type !== 'basic') return;
  if (address !== true && await versionOf(response.clone()) !== address) return;
  await cache.put(href, response);
}

/** The version a request's address names, `true` for a bundle file, or null. */
function contentAddress(url) {
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return null;
  const path = url.pathname.slice(SCOPE.pathname.length);
  if (!path.startsWith('assets/')) return null;
  const version = VERSION_QUERY.exec(url.search);
  if (version !== null) return version[1];
  return url.search === '' && BUNDLE_PATH.test(path) ? true : null;
}

async function versionOf(response) {
  const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
  return [...new Uint8Array(digest, 0, 6)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The kept file, or the network's answer, kept when it is the bytes its
 * address names. Whatever this browser's storage refuses (a private window,
 * a full disk), the network answers as if nothing were kept.
 */
async function answer(event, address) {
  const { request } = event;
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const kept = await cache.match(request.url);
    if (kept !== undefined) return kept;
    const earlier = await caches.match(request.url);
    if (earlier !== undefined) {
      event.waitUntil(cache.put(request.url, earlier.clone()).catch(() => {}));
      return earlier;
    }
  } catch {
    cache = null;
  }
  const response = await fetch(request);
  if (cache !== null && response.status === 200 && response.type === 'basic') {
    const copy = response.clone();
    event.waitUntil((async () => {
      if (address !== true && await versionOf(copy.clone()) !== address) return;
      await cache.put(request.url, copy);
    })().catch(() => {}));
  }
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const address = contentAddress(new URL(request.url));
  if (address === null) return;
  event.respondWith(answer(event, address));
});
