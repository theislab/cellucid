import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  classifySameOriginHealthAdvertisement,
  readExactTrueUrlFlag,
  readOptionalExactUrlParameter,
  resolveStartupUrlIntent,
  selectConnectedDatasetId,
  selectIntentDatasetId
} from '../assets/js/app/startup-url-intent.js';
import {
  normalizeStartupError,
  publishStartupFailure
} from '../assets/js/app/startup-failure.js';
import {
  createDataSourceManager
} from '../assets/js/data/data-source-manager.js';

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
    /must occur at most once/
  );
  assert.throws(
    () => readOptionalExactUrlParameter(
      new URLSearchParams('remote='),
      'remote'
    ),
    /non-empty exact value/
  );
  assert.throws(
    () => readOptionalExactUrlParameter(
      new URLSearchParams('remote=%20server'),
      'remote'
    ),
    /non-empty exact value/
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
    /must be exactly "true"/
  );
});

test('welcome policy is exact for catalog and user-served startup intents', async t => {
  const jupyterConfig = {
    serverUrl: 'http://127.0.0.1:8765',
    viewerId: 'viewer-1',
    viewerToken: 'token-1'
  };

  for (const [name, search] of [
    ['bare catalog', ''],
    ['configured catalog', 'exportsBaseUrl=https%3A%2F%2Fdata.test%2Fexports%2F'],
    ['explicit Suo sample', 'dataset=suo'],
    ['explicit local-demo sample', 'source=local-demo&dataset=suo'],
    ['remote lookalike', 'remotely=https%3A%2F%2Fserver.test'],
    ['GitHub lookalike', 'githubRepo=owner%2Frepo%2Fexports'],
    ['Jupyter lookalike', 'jupyterMode=true'],
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
      'explicit GitHub repository',
      'github=owner%2Frepo%2Fexports',
      null
    ],
    [
      'authenticated Jupyter',
      'jupyter=true&viewerId=viewer-1&viewerToken=token-1',
      jupyterConfig
    ],
    [
      'authenticated Jupyter AnnData',
      'jupyter=true&viewerId=viewer-1&viewerToken=token-1&anndata=true',
      jupyterConfig
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

  await t.test('Jupyter evidence is exact rather than truthy', () => {
    assert.throws(
      () => resolveStartupUrlIntent(
        new URLSearchParams(
          'jupyter=true&viewerId=viewer-1&viewerToken=token-1'
        ),
        true
      ),
      /Jupyter evidence/
    );
  });

  await t.test('source conflicts remain terminal before presentation', () => {
    assert.throws(
      () => resolveStartupUrlIntent(
        new URLSearchParams(
          'remote=http%3A%2F%2Fserver.test&source=local-demo'
        ),
        null
      ),
      /requires source="remote"/
    );
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
  assert.equal(
    classifySameOriginHealthAdvertisement({
      status: 'ok',
      type: 'exported',
      version: '1.2.3'
    }),
    'server'
  );
  assert.equal(
    classifySameOriginHealthAdvertisement({
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      is_backed: true,
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
    () => selectIntentDatasetId(datasets, null, 'Remote source'),
    /exact "dataset".*required/
  );
  assert.throws(
    () => selectIntentDatasetId(datasets, 'missing', 'Remote source'),
    /does not declare requested dataset/
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
    /declared no datasets/
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
      'The same-origin Cellucid source'
    ),
    /does not declare requested dataset/
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
  assert.equal(surface.style.position, 'fixed');
  assert.equal(surface.style.zIndex, '2147483647');
  assert.equal(
    statsElement.textContent,
    'Startup failed: Remote health response is invalid.'
  );
  assert.equal(documentOwner.body.children.length, 1);
  assert.throws(
    () => publishStartupFailure({
      documentOwner,
      error,
      statsElement
    }),
    /already has a visible owner/
  );
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
  assert.match(
    source,
    /if \(remoteDatasetId === null\) \{\s*datasetSelectFocusRequested = true;/
  );
  assert.doesNotMatch(
    source,
    /switchToDataset\(\s*['"]remote['"]\s*,\s*datasets\[0\]/
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
        version: 2,
        id: datasetId,
        name: datasetId,
        description: '',
        cellucid_data_version: '1.0.0',
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
          available_dimensions: [2],
          default_dimension: 2,
          files: { '2d': 'points_2d.bin' }
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

test('DataSourceManager publishes exact source identity and listener failure', async () => {
  const manager = createDataSourceManager();
  manager.registerSource('alpha', createManagerSource('alpha'));
  const listenerFailure = new Error('dataset listener failed');
  const observed = [];
  manager.onDatasetChange(() => {
    throw listenerFailure;
  });
  manager.onDatasetChange(event => {
    observed.push(event);
  });

  await assert.rejects(
    manager.switchToDataset('alpha', 'dataset-a'),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0] === listenerFailure
    )
  );
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
  const manager = createDataSourceManager();
  manager.registerSource(
    'alpha',
    createManagerSource('alpha', {
      onDeactivate() {
        throw deactivationFailure;
      }
    })
  );
  manager.registerSource('beta', createManagerSource('beta'));
  await manager.switchToDataset('alpha', 'dataset-a');

  await assert.rejects(
    manager.switchToDataset('beta', 'dataset-b'),
    error => error === deactivationFailure
  );
  assert.equal(manager.getCurrentSourceType(), 'beta');
  assert.equal(manager.getCurrentDatasetId(), 'dataset-b');
});
