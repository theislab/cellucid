import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

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

function executeGaInit(hostname) {
  const appendedScripts = [];
  const window = {
    location: {
      hostname,
      search: '',
    },
  };
  const document = {
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

  const production = executeGaInit('www.cellucid.com');
  assert.equal(production.appendedScripts.length, 1);
  assert.equal(
    production.appendedScripts[0].src,
    `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`
  );
  assert.equal(production.appendedScripts[0].async, true);
  assert.equal(production.window.cellucidAnalyticsEnabled, true);
  assert.equal(typeof production.window.gtag, 'function');
  assert.equal(production.window.dataLayer.length, 2);
  assert.equal(production.window.dataLayer[1][0], 'config');
  assert.equal(production.window.dataLayer[1][1], MEASUREMENT_ID);

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
