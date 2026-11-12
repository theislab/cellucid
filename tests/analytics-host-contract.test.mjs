import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { VIEWER_PAGE_MODE_PARAMETER } from '../assets/js/data/viewer-protocol.js';

const INDEX_URL = new URL('../index.html', import.meta.url);
const GA_INIT_URL = new URL(
  '../assets/js/app/ui/core/ga-init.js',
  import.meta.url
);
const TRACKER_URL = new URL(
  '../assets/js/analytics/tracker.js',
  import.meta.url
);
const MEASUREMENT_ID = 'G-K4774ZWGEQ';

const [indexHtml, gaInitSource, trackerSource] = await Promise.all([
  readFile(INDEX_URL, 'utf8'),
  readFile(GA_INIT_URL, 'utf8'),
  readFile(TRACKER_URL, 'utf8'),
]);

function executeGaInit(
  hostname,
  search = '?remote=http%3A%2F%2F10.1.2.3%3A8765&dataset=donor7',
  referrer = ''
) {
  const appendedScripts = [];
  const window = {
    location: {
      hostname,
      origin: `https://${hostname}`,
      pathname: '/',
      search,
    },
  };
  const document = {
    referrer,
    createElement(tagName) {
      assert.equal(tagName, 'script');
      return {};
    },
    head: {
      appendChild(node) {
        appendedScripts.push(node);
      },
    },
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    console: {
      warn(message) {
        throw new Error(`unexpected analytics warning: ${message}`);
      },
    },
    document,
    window,
  });
  vm.runInContext(gaInitSource, context, {
    filename: GA_INIT_URL.pathname,
  });
  return { appendedScripts, window };
}

test('analytics is absent on localhost and loaded exactly once on production', () => {
  assert.doesNotMatch(
    indexHtml,
    /<script[^>]+src=["']https:\/\/www\.googletagmanager\.com\/gtag\/js/i,
    'index.html must not load Google Analytics before host selection'
  );

  for (const hostname of ['localhost', '127.0.0.1', '::1']) {
    const local = executeGaInit(hostname);
    assert.deepEqual(local.appendedScripts, []);
    assert.equal(Object.hasOwn(local.window, 'gtag'), false);
    assert.equal(Object.hasOwn(local.window, 'dataLayer'), false);
    assert.equal(local.window.cellucidAnalyticsEnabled, false);
  }

  const production = executeGaInit(
    'www.cellucid.com',
    '?data=https%3A%2F%2Flab.example%2Fa.h5ad%3FX-Amz-Signature%3DSECRET',
    'https://www.cellucid.com/?data=https%3A%2F%2Flab.example%2Fb.h5ad%3Ftoken%3DSECRET'
  );
  assert.equal(production.appendedScripts.length, 1);
  assert.equal(
    production.appendedScripts[0].src,
    `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`
  );
  assert.equal(production.appendedScripts[0].async, true);
  assert.equal(production.window.cellucidAnalyticsEnabled, true);
  assert.equal(typeof production.window.gtag, 'function');
  const calls = JSON.parse(JSON.stringify(Array.from(production.window.dataLayer, call => [...call])));
  assert.deepEqual(calls.map(call => call[0]), ['consent', 'js', 'set', 'config']);
  // What the page lets Google collect is fixed before the tag loads, so a
  // change in the property cannot widen it: no advertising storage, no
  // advertising use of user data (user-provided data), no personalization,
  // no Google signals.
  assert.deepEqual(calls[0], ['consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  }]);
  // Every hit names the page by origin and path: never what it was asked to
  // open (a signed link, a private server), neither its own address nor the
  // address it came from.
  const page = {
    page_location: 'https://www.cellucid.com/',
    page_referrer: 'https://www.cellucid.com/',
  };
  assert.deepEqual(calls[2], ['set', page]);
  assert.deepEqual(calls[3], ['config', MEASUREMENT_ID, {
    ...page,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /SECRET|data=|lab\.example/);

  assert.match(
    trackerSource,
    /window\.cellucidAnalyticsEnabled === true/
  );
  assert.doesNotMatch(
    trackerSource,
    /pendingEvents|MAX_FLUSH_ATTEMPTS|scheduleFlush/,
    'disabled analytics must not enter a retry queue'
  );
});

test('analytics never runs on a viewer page, whatever host serves it', () => {
  // The literal ga-init.js reads before any module runs is the protocol's.
  assert.equal(VIEWER_PAGE_MODE_PARAMETER, 'viewer');
  assert.match(gaInitSource, new RegExp(`VIEWER_PAGE_PARAMETER = '${VIEWER_PAGE_MODE_PARAMETER}'`));
  for (const hostname of ['www.cellucid.com', 'cellucid.com', 'theislab.github.io']) {
    for (const search of [
      // A notebook widget frames the production app (Python and R).
      '?viewer=embedded',
      // A Python or R browser-tab viewer.
      '?viewer=true&viewerId=v1&viewerToken=t1',
      '?viewer=true&viewerId=v1&viewerToken=t1&anndata=true',
      // Any other spelling is still a viewer page, never a reporting one.
      '?viewer=',
    ]) {
      const viewer = executeGaInit(hostname, search);
      assert.deepEqual(viewer.appendedScripts, [], `${hostname}${search}`);
      assert.equal(Object.hasOwn(viewer.window, 'gtag'), false);
      assert.equal(Object.hasOwn(viewer.window, 'dataLayer'), false);
      assert.equal(viewer.window.cellucidAnalyticsEnabled, false);
    }
  }
});
