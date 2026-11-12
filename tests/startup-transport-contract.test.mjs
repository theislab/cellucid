import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  classifySameOriginHealthAdvertisement,
  readExactTrueUrlFlag,
  readOptionalExactUrlParameter,
  resolveStartupUrlIntent,
  isRefusedLaunchLink,
  selectConnectedDatasetId,
  selectIntentDatasetId
} from '../assets/js/app/startup-url-intent.js';
import {
  normalizeStartupError,
  describeStartupFailure,
  publishStartupFailure,
  STARTUP_ISSUES_URL,
  STARTUP_REQUIREMENTS_URL,
  STARTUP_TROUBLESHOOTING_INDEX_URL,
  STARTUP_TROUBLESHOOTING_URL
} from '../assets/js/app/startup-failure.js';
import { DataSourceError } from '../assets/js/data/data-source.js';
import { STARTUP_STALL_CODE } from '../assets/js/app/startup-phase.js';
import { contextLostError } from '../assets/js/rendering/gl-errors.js';
import {
  DataSourceManager
} from '../assets/js/data/data-source-manager.js';
import { selectDataset } from './helpers/dataset-selection.mjs';
import { isExplainedFailure } from '../assets/js/data/data-source.js';
import { isSettledDataSourceFailure } from '../assets/js/app/ui/modules/dataset-connections.js';

function createFakeDocument() {
  const elements = new Map();
  const makeElement = tagName => ({
    tagName,
    id: '',
    textContent: '',
    style: {},
    attributes: new Map(),
    children: [],
    focusCalls: 0,
    focus() {
      this.focusCalls++;
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
      if (child.id !== '') elements.set(child.id, child);
      return child;
    }
  });
  const body = makeElement('body');
  return {
    body,
    location: { pathname: '/', search: '?dataset=missing' },
    createElement: makeElement,
    getElementById(id) {
      return elements.get(id) ?? null;
    }
  };
}

test('startup parameters reject duplicates, empty values, and boolean coercion', () => {
  assert.equal(
    readOptionalExactUrlParameter(
      new URLSearchParams('remote=https%3A%2F%2Fexample.test'),
      'remote'
    ),
    'https://example.test'
  );
  assert.equal(
    readOptionalExactUrlParameter(new URLSearchParams(''), 'remote'),
    null
  );
  assert.throws(
    () => readOptionalExactUrlParameter(
      new URLSearchParams('remote=a&remote=b'),
      'remote'
    ),
    /This link names "remote" 2 times; a link names it once\./
  );
  assert.throws(
    () => readOptionalExactUrlParameter(
      new URLSearchParams('remote='),
      'remote'
    ),
    /This link's "remote" has no value\./
  );
  assert.throws(
    () => readOptionalExactUrlParameter(
      new URLSearchParams('remote=%20server'),
      'remote'
    ),
    /This link's "remote" has spaces around its value \(" server"\); remove them\./
  );
  assert.equal(
    readExactTrueUrlFlag(
      new URLSearchParams('anndata=true'),
      'anndata'
    ),
    true
  );
  assert.throws(
    () => readExactTrueUrlFlag(
      new URLSearchParams('anndata=1'),
      'anndata'
    ),
    /This link's "anndata" is "1"; it can only be "true"\./
  );
});

test('welcome policy is exact for catalog and user-served startup intents', async t => {
  const viewerHostConfig = {
    serverUrl: 'http://127.0.0.1:8765',
    viewerId: 'viewer-1',
    viewerToken: 'token-1'
  };

  for (const [name, search] of [
    ['bare catalog', ''],
    ['configured catalog', 'sampleCatalog=https%3A%2F%2Fdata.test%2Fanndata%2F'],
    ['explicit Suo sample', 'dataset=suo'],
    ['explicit local-demo sample', 'source=local-demo&dataset=suo'],
    ['remote lookalike', 'remotely=https%3A%2F%2Fserver.test'],
    ['data link lookalike', 'dataset_link=gh%3Aowner%2Frepo'],
    ['Viewer host lookalike', 'viewerHostMode=true'],
  ]) {
    await t.test(`${name} shows onboarding`, () => {
      const intent = resolveStartupUrlIntent(
        new URLSearchParams(search),
        null
      );
      assert.equal(intent.shouldShowWelcome, true);
    });
  }

  for (const [name, search, config] of [
    [
      'explicit remote URL',
      'remote=http%3A%2F%2F127.0.0.1%3A8765',
      null
    ],
    ['same-origin prepared server', 'source=remote', null],
    ['same-origin AnnData server', 'anndata=true', null],
    [
      'explicit data link',
      'data=gh%3Aowner%2Frepo%2Fexports',
      null
    ],
    [
      'authenticated Jupyter',
      'viewer=true&viewerId=viewer-1&viewerToken=token-1',
      viewerHostConfig
    ],
    [
      'authenticated Jupyter AnnData',
      'viewer=true&viewerId=viewer-1&viewerToken=token-1&anndata=true',
      viewerHostConfig
    ],
  ]) {
    await t.test(`${name} suppresses onboarding`, () => {
      const intent = resolveStartupUrlIntent(
        new URLSearchParams(search),
        config
      );
      assert.equal(intent.shouldShowWelcome, false);
    });
  }

  await t.test('Viewer host evidence is exact rather than truthy', () => {
    assert.throws(
      () => resolveStartupUrlIntent(
        new URLSearchParams(
          'viewer=true&viewerId=viewer-1&viewerToken=token-1'
        ),
        true
      ),
      /viewer host evidence/
    );
  });

  await t.test('a link Cellucid cannot read is refused as the link\'s, before anything is presented', () => {
    // R9E-1: refused as the link's (said on its opening card, Cellucid
    // running), never as Cellucid failing to start.
    for (const [search, said] of [
      ['remote=http%3A%2F%2Fserver.test&source=local-demo', /names a Cellucid server \("remote"\) but its "source" is "local-demo"; remove "source"\./],
      ['remote=http%3A%2F%2Fserver.test&data=x', /names both a Cellucid server \("remote"\) and data \("data"\)/],
      ['data=x&source=local-demo', /"data" names where its data is; remove "source"\./],
      // The pair's own reason, before "an unknown source".
      ['data=x&source=link', /"data" names where its data is; remove "source"\./],
      ['anndata=true&source=local-demo', /"anndata=true" names a Cellucid server, but its "source" is "local-demo"/],
      ['source=foo', /"source" is "foo"; a link's source is "local-demo" \(a sample dataset\) or "remote"/],
      ['source=jupyter', /"source" is "jupyter"/],
      ['dataset=a&dataset=b', /names "dataset" 2 times/],
    ]) {
      assert.throws(
        () => resolveStartupUrlIntent(new URLSearchParams(search), null),
        error => said.test(error.message) && isRefusedLaunchLink(error) && isExplainedFailure(error)
          && isSettledDataSourceFailure(error),
        search
      );
    }
  });
});

test('same-origin health advertisement has exact static and server identities', () => {
  assert.equal(
    classifySameOriginHealthAdvertisement({
      status: 'static',
      type: 'web',
      message: 'Cellucid web viewer (no same-origin Python server)'
    }),
    'static'
  );
  // The prepared-export server is gone; its health is no server identity.
  assert.throws(
    () => classifySameOriginHealthAdvertisement({
      status: 'ok',
      type: 'exported',
      version: '1.2.3'
    }),
    /no current server or static identity/
  );
  assert.equal(
    classifySameOriginHealthAdvertisement({
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      n_cells: 3,
      n_genes: 2
    }),
    'server'
  );
  assert.throws(
    () => classifySameOriginHealthAdvertisement({
      status: 'static',
      type: 'web',
      message: 'old marker'
    }),
    /does not match the current contract/
  );
  assert.throws(
    () => classifySameOriginHealthAdvertisement({
      status: 'ok',
      type: 'other'
    }),
    /no current server or static identity/
  );
});

test('explicit source selection never substitutes the first dataset', () => {
  const datasets = [{ id: 'alpha' }, { id: 'beta' }];
  assert.equal(
    selectIntentDatasetId(datasets, 'beta', 'Remote source'),
    'beta'
  );
  assert.throws(
    () => selectIntentDatasetId(datasets, null, 'The server this link names'),
    error => isRefusedLaunchLink(error) && error.message ===
      'The server this link names holds 2 datasets ("alpha" and "beta"), and this link does not say which to open: add "dataset=" with one of them.'
  );
  assert.throws(
    () => selectIntentDatasetId(datasets, 'missing', 'The server this link names'),
    error => isRefusedLaunchLink(error) && error.message ===
      'This link names the dataset "missing", which the server this link names does not hold; it holds "alpha" and "beta".'
  );
  assert.throws(
    () => selectIntentDatasetId(
      [{ id: 'alpha' }, { id: 'alpha' }],
      'alpha',
      'Remote source'
    ),
    /unique non-empty exact id/
  );
  assert.throws(
    () => selectIntentDatasetId([], null, 'Remote source'),
    /holds no dataset/
  );
  assert.equal(
    selectIntentDatasetId([{ id: 'only' }], null, 'Remote source'),
    'only'
  );
});

test('same-origin served catalogs auto-select only an exact unique dataset', () => {
  const datasets = [{ id: 'alpha' }, { id: 'beta' }];
  assert.equal(
    selectConnectedDatasetId(
      datasets,
      null,
      'The same-origin Cellucid source'
    ),
    null
  );
  assert.equal(
    selectConnectedDatasetId(
      datasets,
      'beta',
      'The same-origin Cellucid source'
    ),
    'beta'
  );
  assert.equal(
    selectConnectedDatasetId(
      [{ id: 'only' }],
      null,
      'The same-origin Cellucid source'
    ),
    'only'
  );
  assert.throws(
    () => selectConnectedDatasetId(
      datasets,
      'missing',
      'This Cellucid server'
    ),
    /names the dataset "missing", which this Cellucid server does not hold/
  );
});

test('terminal startup failure has one persistent accessible visible owner', () => {
  const documentOwner = createFakeDocument();
  const statsElement = { textContent: 'Loading' };
  const error = new Error('Remote health response is invalid.');
  const surface = publishStartupFailure({
    documentOwner,
    error,
    statsElement
  });

  assert.equal(surface.id, 'cellucid-startup-failure');
  assert.equal(surface.attributes.get('role'), 'alert');
  assert.equal(surface.attributes.get('aria-live'), 'assertive');
  // Onboarding is retracted as this surface is published, so focus has to land
  // somewhere: on the alert itself, not on a control that just disappeared.
  assert.equal(surface.attributes.get('tabindex'), '-1');
  assert.equal(surface.focusCalls, 1);
  // The brand card over everything, styled by the shared stylesheet: no
  // inline style of its own.
  assert.equal(surface.className, 'page-screen page-screen-fixed');
  assert.deepEqual(surface.style, {});
  assert.equal(surface.attributes.get('data-failure'), 'app');
  assert.equal(
    statsElement.textContent,
    'Startup failed: Remote health response is invalid.'
  );
  assert.equal(documentOwner.body.children.length, 1);
  const [card] = surface.children;
  assert.equal(card.className, 'welcome-content');
  const [header, body] = card.children;
  assert.equal(header.children[0].attributes.get('src'), 'assets/img/cellucid-logo.svg');
  const [title, sentence, actions, details, links] = body.children;
  // What happened and what to do, for a person; the technical message only
  // under Details.
  assert.equal(title.textContent, 'Cellucid could not start');
  assert.equal(
    sentence.textContent,
    'Something went wrong while starting. Try again, or open Cellucid without this link\u2019s settings.'
  );
  assert.equal(details.tagName, 'details');
  assert.equal(details.children[0].textContent, 'Details');
  assert.equal(details.children[1].textContent, 'Remote health response is invalid.');
  // Never a dead end: the same address again, the app without the link's
  // settings, and where to read or report more.
  assert.deepEqual(
    actions.children.map(row => [row.attributes.get('href'), row.children[1].children[0].textContent]),
    [
      ['/?dataset=missing', 'Try again'],
      ['/', 'Open Cellucid without this link']
    ]
  );
  assert.deepEqual(
    links.children.map(item => [item.children[0].attributes.get('href'), item.children[0].textContent]),
    [
      [STARTUP_TROUBLESHOOTING_INDEX_URL, 'Troubleshooting'],
      [STARTUP_ISSUES_URL, 'Report a problem']
    ]
  );
  assert.match(STARTUP_TROUBLESHOOTING_URL, /^https:\/\/docs\.cellucid\.com\/en\/latest\//);
  assert.throws(
    () => publishStartupFailure({
      documentOwner,
      error,
      statsElement
    }),
    /already has a visible owner/
  );
});

test('a failed start is described by what failed, never by its technical message', () => {
  const withLink = { webgl2Available: true, hasLaunchSettings: true };
  const message = 'Failed to open 10.6084/x: https://ndownloader.example/files/1: the host answered HTTP 202.';
  const dataFailure = describeStartupFailure(new DataSourceError(message, 'NETWORK_ERROR', 'link'), withLink);
  assert.equal(dataFailure.kind, 'data');
  assert.equal(dataFailure.title, 'The data could not be opened');
  assert.equal(dataFailure.offerWithoutSettings, true);
  assert.deepEqual(dataFailure.links, [[STARTUP_TROUBLESHOOTING_URL, 'Troubleshooting data loading']]);

  const explained = new Error('missing.h5ad was not found at example.org (HTTP 404).');
  explained.details = { explained: true };
  assert.equal(describeStartupFailure(explained, withLink).kind, 'data');

  const stall = new Error('Startup stalled while checking the data server: /_cellucid/health did not answer within 60 s.');
  stall.code = STARTUP_STALL_CODE;
  assert.equal(describeStartupFailure(stall, withLink).kind, 'stall');

  // No WebGL2 is the browser, whatever was thrown, and a link cannot help.
  const browser = describeStartupFailure(
    new DataSourceError('WebGL2 is required but not supported in this browser.', 'X', 'link'),
    { webgl2Available: false, hasLaunchSettings: true }
  );
  assert.equal(browser.kind, 'browser');
  assert.equal(browser.offerWithoutSettings, false);
  assert.deepEqual(browser.links, [[STARTUP_REQUIREMENTS_URL, 'System requirements']]);

  // The browser's graphics stopped working (its context lost as it was made,
  // or later while starting): reload, else restart the browser; a link
  // cannot help, and no shader or other inner reason is said.
  const graphics = describeStartupFailure(contextLostError('The viewer'), withLink);
  assert.equal(graphics.kind, 'graphics');
  assert.equal(graphics.title, 'The browser\u2019s graphics stopped working');
  assert.match(graphics.sentence, /Reload the page; if this happens again, restart the browser\./);
  assert.equal(graphics.offerWithoutSettings, false);
  assert.deepEqual(graphics.links, [[STARTUP_TROUBLESHOOTING_INDEX_URL, 'Troubleshooting']]);

  const plain = describeStartupFailure(new Error('x'), { webgl2Available: true, hasLaunchSettings: false });
  assert.equal(plain.kind, 'app');
  assert.equal(plain.offerWithoutSettings, false);
  assert.equal(plain.sentence, 'Something went wrong while starting. Try again in a moment.');

  for (const described of [dataFailure, browser, graphics, plain]) {
    assert.doesNotMatch(`${described.title} ${described.sentence}`, /https?:|HTTP \d|10\.6084/);
  }
  for (const url of [STARTUP_TROUBLESHOOTING_URL, STARTUP_REQUIREMENTS_URL, STARTUP_TROUBLESHOOTING_INDEX_URL]) {
    assert.match(url, /^https:\/\/docs\.cellucid\.com\/en\/latest\/user_guide\/web_app\//);
  }
});

test('startup thrown values normalize to one Error contract', () => {
  const exact = new Error('exact');
  assert.equal(normalizeStartupError(exact), exact);
  const noMessage = normalizeStartupError(new Error(''));
  assert.match(noMessage.message, /without an error message/);
  const nonError = normalizeStartupError('failure');
  assert.match(nonError.message, /non-Error value/);
  assert.equal(nonError.cause, 'failure');
});

test('main startup uses terminal source intent and one fatal surface', async () => {
  const source = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /remoteUrlParam !== null/);
  assert.match(source, /selectIntentDatasetId\(/);
  assert.match(
    source,
    /const remoteDatasetId = selectConnectedDatasetId\(/
  );
  // Many server datasets: the user is told to choose one, and startup never
  // activates the Sample dataset dropdown for them.
  assert.match(
    source,
    /if \(remoteDatasetId === null\) \{\s*notifications\.info\(/
  );
  assert.doesNotMatch(source, /datasetSelectFocusRequested|datasetSelect\.focus\(/);
  assert.doesNotMatch(
    source,
    /selectStartupDataset\(\s*['"]remote['"]\s*,\s*datasets\[0\]/
  );
  assert.match(source, /publishStartupFailure\(\{/);
  assert.doesNotMatch(
    source,
    /Failed to connect to remote server.*console\.warn/s
  );
  assert.doesNotMatch(
    source,
    /Same-origin server detected but auto-connect failed/
  );
  assert.doesNotMatch(
    source,
    /healthRes\.json\(\)\.catch/
  );
});

function createManagerSource(type, {
  onDeactivate = null
} = {}) {
  const source = {
    async getMetadata(datasetId) {
      return {
        id: datasetId,
        name: datasetId,
        description: '',
        stats: {
          n_cells: 1,
          n_genes: 0,
          n_obs_fields: 0,
          n_categorical_fields: 0,
          n_continuous_fields: 0,
          has_connectivity: false,
          n_edges: null
        },
        embeddings: {
          default_dimension: 2,
          defaults: { '2d': 'X_umap' },
          items: {
            X_umap: {
              label: 'X_umap',
              dimension: 2,
              path: 'obsm/0/0-1',
              source: { key: 'X_umap', columns: [0, 1] }
            }
          }
        },
        obs_fields: []
      };
    },
    getBaseUrl(datasetId) {
      return `https://example.test/${datasetId}/`;
    },
    getType() {
      return type;
    }
  };
  if (onDeactivate !== null) {
    source.onDeactivate = onDeactivate;
  }
  return source;
}

test('DataSourceManager publishes exact source identity; a failing listener is reported, never the opening\'s failure', async () => {
  const manager = new DataSourceManager();
  manager.registerSource('alpha', createManagerSource('alpha'));
  const listenerFailure = new Error('dataset listener failed');
  const observed = [];
  manager.onDatasetChange(() => {
    throw listenerFailure;
  });
  manager.onDatasetChange(event => {
    observed.push(event);
  });

  const reported = [];
  const consoleError = console.error;
  console.error = (message, error) => reported.push(error);
  try {
    await selectDataset(manager, 'alpha', 'dataset-a');
  } finally {
    console.error = consoleError;
  }
  assert.deepEqual(reported, [listenerFailure]);
  assert.equal(manager.getCurrentSourceType(), 'alpha');
  assert.equal(manager.getCurrentDatasetId(), 'dataset-a');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].previousSourceType, null);

  manager.activeSource = {
    getType() {
      return ' alpha ';
    }
  };
  assert.throws(
    () => manager.getCurrentSourceType(),
    /non-empty trimmed string/
  );
  assert.throws(
    () => manager.onDatasetChange(null),
    /must be a function/
  );
});

test('DataSourceManager cleanup failure retains the published new selection', async () => {
  const deactivationFailure = new Error('deactivation failed');
  const manager = new DataSourceManager();
  manager.registerSource(
    'alpha',
    createManagerSource('alpha', {
      onDeactivate() {
        throw deactivationFailure;
      }
    })
  );
  manager.registerSource('beta', createManagerSource('beta'));
  await selectDataset(manager, 'alpha', 'dataset-a');

  await assert.rejects(
    selectDataset(manager, 'beta', 'dataset-b'),
    error => error === deactivationFailure
  );
  assert.equal(manager.getCurrentSourceType(), 'beta');
  assert.equal(manager.getCurrentDatasetId(), 'dataset-b');
});

test('a link\'s "remote" is spelled as the address bar spells a server', async () => {
  // R9E-3: `?remote=http://127.0.0.1:8765/` (a trailing slash, as people
  // write a server) was refused as "not one canonical spelling".
  const { canonicalServerAddress } = await import('../assets/js/app/ui/modules/address-routing.js');
  const { validateRemoteServerUrl } = await import('../assets/js/data/remote-source.js');
  for (const [given, canonical] of [
    ['http://127.0.0.1:8765/', 'http://127.0.0.1:8765'],
    ['HTTP://Lab-Server:8765//', 'http://lab-server:8765'],
    ['https://data.example.org/cellucid/', 'https://data.example.org/cellucid'],
    ['http://127.0.0.1:8765', 'http://127.0.0.1:8765'],
  ]) {
    assert.equal(canonicalServerAddress(given), canonical, given);
    assert.equal(validateRemoteServerUrl(canonicalServerAddress(given)), canonical);
  }
  // Text that is no server address is left for the refusal to name.
  assert.equal(canonicalServerAddress('not a url'), 'not a url');
  assert.equal(canonicalServerAddress('http://h:1/?q=1'), 'http://h:1/?q=1');
});

test('a browser with WebGL2 that refuses the viewer a context is told about its graphics, not "Something went wrong"', async () => {
  // R9E-6: `getContext('webgl2')` null for the viewer only (a reset graphics
  // process, too many contexts) was said as the app failing to start.
  const { contextRefusedError } = await import('../assets/js/rendering/gl-errors.js');
  const refused = contextRefusedError('The viewer');
  const graphics = describeStartupFailure(refused, { webgl2Available: true, hasLaunchSettings: true });
  assert.equal(graphics.kind, 'graphics');
  assert.equal(graphics.offerWithoutSettings, false);
  assert.match(graphics.sentence, /would not give Cellucid a graphics context/);
  // A browser with no WebGL2 at all is still told so.
  assert.equal(describeStartupFailure(refused, { webgl2Available: false, hasLaunchSettings: false }).kind, 'browser');
});
