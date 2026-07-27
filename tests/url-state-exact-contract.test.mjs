import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearUrlDataSource,
  prepareUrlForDatasetSelection,
  prepareUrlForDataSource,
  updateUrlForDataSource,
} from '../assets/js/app/url-state.js';

const INITIAL_URL =
  'https://viewer.example.test/app?' +
  'dataset=old&source=old&remote=https%3A%2F%2Fold.example.test' +
  '&github=old%2Frepo&annotations=team%2Flabels%40main#selected';

function installBrowser(initialHref = INITIAL_URL, replaceImplementation = null) {
  const previousWindow = globalThis.window;
  const previousHistory = globalThis.history;
  let href = initialHref;
  const calls = [];
  const location = {};

  Object.defineProperties(location, {
    href: {
      configurable: true,
      get() {
        return href;
      },
    },
    search: {
      configurable: true,
      get() {
        return new URL(href).search;
      },
    },
  });

  const history = {
    replaceState(state, title, nextHref) {
      calls.push({ state, title, nextHref });
      if (replaceImplementation !== null) {
        return replaceImplementation(nextHref);
      }
      href = nextHref;
      return undefined;
    },
  };

  globalThis.window = { location, history };
  globalThis.history = history;

  return {
    calls,
    get href() {
      return href;
    },
    restore() {
      globalThis.window = previousWindow;
      globalThis.history = previousHistory;
    },
  };
}

function assertPreservedApplicationState(nextHref) {
  const url = new URL(nextHref);
  assert.equal(url.searchParams.get('annotations'), 'team/labels@main');
  assert.equal(url.hash, '#selected');
  return url;
}

async function withBrowser(run, options = {}) {
  const browser = installBrowser(options.initialHref, options.replaceImplementation);
  try {
    await run(browser);
  } finally {
    browser.restore();
  }
}

test('local-demo publishes exactly its dataset URL state', async () => {
  await withBrowser(browser => {
    updateUrlForDataSource('local-demo', { datasetId: 'pbmc-3k' });

    assert.equal(browser.calls.length, 1);
    const url = assertPreservedApplicationState(browser.href);
    assert.equal(url.searchParams.get('dataset'), 'pbmc-3k');
    assert.equal(url.searchParams.has('source'), false);
    assert.equal(url.searchParams.has('remote'), false);
    assert.equal(url.searchParams.has('github'), false);
  });
});

test('remote publishes exactly its server and dataset URL state', async () => {
  await withBrowser(browser => {
    updateUrlForDataSource('remote', {
      datasetId: 'served',
      serverUrl: 'https://data.example.test/cellucid',
    });

    assert.equal(browser.calls.length, 1);
    const url = assertPreservedApplicationState(browser.href);
    assert.equal(
      url.searchParams.get('remote'),
      'https://data.example.test/cellucid'
    );
    assert.equal(url.searchParams.get('dataset'), 'served');
    assert.equal(url.searchParams.has('source'), false);
    assert.equal(url.searchParams.has('github'), false);
  });
});

test('github-repo publishes exactly its repository and dataset URL state', async () => {
  await withBrowser(browser => {
    updateUrlForDataSource('github-repo', {
      datasetId: 'atlas',
      path: 'cellucid/data/example',
    });

    assert.equal(browser.calls.length, 1);
    const url = assertPreservedApplicationState(browser.href);
    assert.equal(url.searchParams.get('github'), 'cellucid/data/example');
    assert.equal(url.searchParams.get('dataset'), 'atlas');
    assert.equal(url.searchParams.has('source'), false);
    assert.equal(url.searchParams.has('remote'), false);
  });
});

for (const sourceType of ['local-user', 'jupyter']) {
  test(`${sourceType} publishes its exact URL-free source state`, async () => {
    await withBrowser(browser => {
      updateUrlForDataSource(sourceType, {});

      assert.equal(browser.calls.length, 1);
      const url = assertPreservedApplicationState(browser.href);
      assert.equal(url.searchParams.has('dataset'), false);
      assert.equal(url.searchParams.has('source'), false);
      assert.equal(url.searchParams.has('remote'), false);
      assert.equal(url.searchParams.has('github'), false);
    });
  });
}

test('null publishes the exact empty-dataset state', async () => {
  await withBrowser(browser => {
    updateUrlForDataSource(null, {});

    assert.equal(browser.calls.length, 1);
    const url = assertPreservedApplicationState(browser.href);
    assert.equal(url.searchParams.has('dataset'), false);
    assert.equal(url.searchParams.has('source'), false);
    assert.equal(url.searchParams.has('remote'), false);
    assert.equal(url.searchParams.has('github'), false);
  });
});

test('clearUrlDataSource publishes the exact empty-dataset state', async () => {
  await withBrowser(browser => {
    clearUrlDataSource();

    assert.equal(browser.calls.length, 1);
    const url = assertPreservedApplicationState(browser.href);
    assert.equal(url.searchParams.has('dataset'), false);
    assert.equal(url.searchParams.has('source'), false);
    assert.equal(url.searchParams.has('remote'), false);
    assert.equal(url.searchParams.has('github'), false);
  });
});

test('invalid, empty, partial, and unknown source records preserve the prior URL', async () => {
  const invalidCalls = [
    () => updateUrlForDataSource(),
    () => updateUrlForDataSource(undefined, {}),
    () => updateUrlForDataSource('', {}),
    () => updateUrlForDataSource('unknown', {}),
    () => updateUrlForDataSource('local-demo'),
    () => updateUrlForDataSource('local-demo', {}),
    () => updateUrlForDataSource('local-demo', { datasetId: '' }),
    () => updateUrlForDataSource('local-demo', { datasetId: ' pbmc-3k' }),
    () => updateUrlForDataSource('local-demo', { datasetId: 'pbmc\n3k' }),
    () => updateUrlForDataSource('remote', {}),
    () => updateUrlForDataSource('remote', { serverUrl: '' }),
    () => updateUrlForDataSource('remote', { serverUrl: 'ftp://data.test' }),
    () => updateUrlForDataSource('remote', {
      datasetId: 'served',
      serverUrl: 'https://data.test/',
    }),
    () => updateUrlForDataSource('remote', {
      datasetId: 'served',
      serverUrl: 'https://user@data.test',
    }),
    () => updateUrlForDataSource('remote', {
      datasetId: 'served',
      serverUrl: 'https://data.test?candidate=true',
    }),
    () => updateUrlForDataSource('remote', {
      datasetId: 'served',
      serverUrl: 'https://data.test#candidate',
    }),
    () => updateUrlForDataSource('remote', {
      datasetId: '',
      serverUrl: 'https://data.test',
    }),
    () => updateUrlForDataSource('remote', {
      serverUrl: 'https://data.test',
    }),
    () => updateUrlForDataSource('github-repo', {}),
    () => updateUrlForDataSource('github-repo', { path: ' ' }),
    () => updateUrlForDataSource('github-repo', {
      datasetId: '',
      path: 'owner/repo',
    }),
    () => updateUrlForDataSource('github-repo', {
      path: 'owner/repo',
    }),
    () => updateUrlForDataSource('local-user', { datasetId: 'local' }),
    () => updateUrlForDataSource('jupyter', { serverUrl: 'https://data.test' }),
    () => updateUrlForDataSource(null, { datasetId: 'old' }),
    () => updateUrlForDataSource('local-user', null),
    () => updateUrlForDataSource('jupyter', []),
  ];

  for (const invalidCall of invalidCalls) {
    await withBrowser(browser => {
      const priorHref = browser.href;
      assert.throws(invalidCall);
      assert.equal(browser.calls.length, 0);
      assert.equal(browser.href, priorHref);
    });
  }
});

test('source records reject extra, inherited, accessor, and symbol fields before mutation', async () => {
  const inherited = Object.create({ datasetId: 'pbmc-3k' });
  const accessor = {};
  Object.defineProperty(accessor, 'datasetId', {
    enumerable: true,
    get() {
      return 'pbmc-3k';
    },
  });
  const withSymbol = { datasetId: 'pbmc-3k' };
  withSymbol[Symbol('extra')] = true;

  const invalidRecords = [
    { datasetId: 'pbmc-3k', extra: true },
    inherited,
    accessor,
    withSymbol,
  ];

  for (const record of invalidRecords) {
    await withBrowser(browser => {
      const priorHref = browser.href;
      assert.throws(() => updateUrlForDataSource('local-demo', record));
      assert.equal(browser.calls.length, 0);
      assert.equal(browser.href, priorHref);
    });
  }
});

test('history publication failure leaves the prior browser URL intact', async () => {
  const publicationError = new Error('history unavailable');
  await withBrowser(
    browser => {
      const priorHref = browser.href;
      assert.throws(
        () =>
          updateUrlForDataSource('local-demo', {
            datasetId: 'pbmc-3k',
          }),
        error => error === publicationError
      );
      assert.equal(browser.calls.length, 1);
      assert.equal(browser.href, priorHref);
    },
    {
      replaceImplementation() {
        throw publicationError;
      },
    }
  );
});

test('prepared URL publication validates before mutation and can restore its exact prior URL', async () => {
  await withBrowser(browser => {
    const priorHref = browser.href;
    const publication = prepareUrlForDataSource('remote', {
      datasetId: 'served',
      serverUrl: 'https://data.example.test/cellucid',
    });

    assert.equal(browser.calls.length, 0);
    assert.equal(browser.href, priorHref);
    publication.commit();
    assert.equal(browser.calls.length, 1);
    assert.equal(
      new URL(browser.href).searchParams.get('dataset'),
      'served'
    );
    publication.rollback();
    assert.equal(browser.calls.length, 2);
    assert.equal(browser.href, priorHref);
    assert.throws(() => publication.commit(), /already committed/i);
    assert.throws(() => publication.rollback(), /already restored/i);
  });
});

test('an older URL publication cannot restore over a newer committed generation', async () => {
  await withBrowser(browser => {
    const initialHref = browser.href;
    const older = prepareUrlForDataSource('remote', {
      datasetId: 'remote-a',
      serverUrl: 'https://remote-a.test',
    });
    const newer = prepareUrlForDataSource('github-repo', {
      datasetId: 'github-b',
      path: 'owner/repo/exports',
    });

    older.commit();
    const olderHref = browser.href;
    newer.commit();
    const newerHref = browser.href;
    assert.notEqual(olderHref, newerHref);

    assert.throws(() => older.rollback(), /newer|superseded/i);
    assert.equal(browser.href, newerHref);
    newer.rollback();
    assert.equal(browser.href, olderHref);
    assert.notEqual(browser.href, initialHref);
    assert.throws(() => older.rollback(), /newer|superseded/i);
    assert.equal(browser.href, olderHref);
  });
});

test('selection URL preparation reads one exact candidate source without mutation', async () => {
  await withBrowser(browser => {
    const priorHref = browser.href;
    const source = {
      getConnectionInfo() {
        return {
          status: 'connected',
          url: 'https://candidate.example.test/cellucid',
        };
      },
      getType() {
        return 'remote';
      },
    };
    const publication = prepareUrlForDatasetSelection({
      datasetId: 'candidate',
      source,
      sourceType: 'remote',
    });
    assert.equal(browser.href, priorHref);
    assert.equal(browser.calls.length, 0);
    publication.commit();
    const url = new URL(browser.href);
    assert.equal(
      url.searchParams.get('remote'),
      'https://candidate.example.test/cellucid'
    );
    assert.equal(url.searchParams.get('dataset'), 'candidate');
  });
});
