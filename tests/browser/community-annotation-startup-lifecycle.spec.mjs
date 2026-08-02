import { expect, test } from './helpers/test.mjs';

import { APP_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const WORKER_ORIGIN = 'https://worker.example';
const EXPORTS_ROOT =
  `${APP_ORIGIN}/tests/browser/fixtures/exports/`;
const AUTH_USER = Object.freeze({ id: 4242, login: 'tester' });
const AUTH_USER_KEY = `ghid_${AUTH_USER.id}`;
const FIRST_DATASET_ID = 'current-ui-prepared';
const SECOND_DATASET_ID = 'current-ui-alternate';
const SECOND_DATASET_NAME = 'Current UI alternate fixture';
const SECOND_DATASET_OPTION =
  `dataset:local-demo:${SECOND_DATASET_ID}`;
const FIRST_REPO = 'team/labels';
const SECOND_REPO = 'team/new-labels';
const EMPTY_USERS_SENTINEL_SHA =
  '8b137891791fe96927ad78e64b0aad7bded08bdc';
const OPERATION_ID_HEADER = 'x-cellucid-operation-id';
const UNKNOWN_PUBLICATION_GUIDANCE =
  'GitHub may already have applied this change. Pull from the same annotation ' +
  'repository before publishing again; do not retry until that Pull completes.';

function workerCapabilityDocument() {
  return {
    status: 'ok',
    service: 'Cellucid GitHub Auth',
    contractVersion: 1,
    endpoints: [
      '/auth/login',
      '/auth/callback',
      '/auth/user',
      '/auth/installations',
      '/auth/installation-repos',
      '/cap/lookup-cells',
      '/cap/search-datasets',
      '/api/repos/*',
    ],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function installWorkerCapability(page, document = null) {
  const capability =
    document === null ? workerCapabilityDocument() : document;
  await page.route(`${WORKER_ORIGIN}/`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(capability),
    });
  });
}

async function installAutoPullTimerProbe(page, preferences = null) {
  await page.addInitScript(initialPreferences => {
    const preferenceKey =
      'cellucid:community-annotations:auto-pull:v1';
    if (initialPreferences !== null) {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify(initialPreferences)
      );
    }
    const nativeSetInterval = window.setInterval;
    const nativeClearInterval = window.clearInterval;
    const nativeStorageSetItem = Storage.prototype.setItem;
    const trackedDelays = new Set([600_000, 900_000, 3_600_000]);
    const active = new Map();
    const probe = {
      active,
      clears: 0,
      creates: 0,
      failNextPreferenceWrite: false,
      failNextTrackedCreate: false,
    };
    Storage.prototype.setItem = function exactAutoPullPreferenceWrite(
      key,
      value
    ) {
      if (
        this === localStorage &&
        key === preferenceKey &&
        probe.failNextPreferenceWrite
      ) {
        probe.failNextPreferenceWrite = false;
        throw new DOMException(
          'Synthetic auto-pull preference storage failure',
          'QuotaExceededError'
        );
      }
      return nativeStorageSetItem.call(this, key, value);
    };
    window.setInterval = function trackAutoPullInterval(
      callback,
      delay,
      ...args
    ) {
      if (
        trackedDelays.has(Number(delay)) &&
        probe.failNextTrackedCreate
      ) {
        probe.failNextTrackedCreate = false;
        throw new Error(
          'Synthetic auto-pull interval creation failure'
        );
      }
      const id = nativeSetInterval.call(
        this,
        callback,
        delay,
        ...args
      );
      if (trackedDelays.has(Number(delay))) {
        probe.creates += 1;
        active.set(id, Number(delay));
      }
      return id;
    };
    window.clearInterval = function clearAutoPullInterval(id) {
      if (active.delete(id)) probe.clears += 1;
      return nativeClearInterval.call(this, id);
    };
    window.__cellucidAutoPullTimerProbe = probe;
  }, preferences);
}

async function autoPullTimerSnapshot(page) {
  return page.evaluate(() => {
    const probe = window.__cellucidAutoPullTimerProbe;
    if (!probe) throw new Error('Auto-pull timer probe is unavailable');
    return {
      active: probe.active.size,
      activeDelays: [...probe.active.values()].sort((a, b) => a - b),
      clears: probe.clears,
      creates: probe.creates,
    };
  });
}

function withoutExpectedServiceUnavailableConsole(errors) {
  return errors.filter(error => {
    if (!error.startsWith('console: ')) return true;
    return !(
      /failed to load resource/i.test(error) &&
      /503|service unavailable/i.test(error)
    );
  });
}

async function installStoredAuthentication(page) {
  await page.addInitScript(({ workerOrigin, user }) => {
    window.__CELLUCID_GITHUB_WORKER_ORIGIN__ = workerOrigin;
    sessionStorage.setItem(
      'cellucid:github-app-auth:session',
      JSON.stringify({
        token: 'synthetic-token',
        user,
      }),
    );
  }, {
    workerOrigin: WORKER_ORIGIN,
    user: AUTH_USER,
  });
  await installWorkerCapability(page);
  await page.route(`${WORKER_ORIGIN}/auth/user`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AUTH_USER),
    });
  });
}

function repoInfo(fullName, { author }) {
  return {
    full_name: fullName,
    default_branch: 'main',
    private: false,
    allow_forking: true,
    permissions: {
      pull: true,
      triage: false,
      push: true,
      maintain: author,
      admin: author,
    },
  };
}

function configDocument() {
  return {
    version: 1,
    supportedDatasets: [
      {
        datasetId: FIRST_DATASET_ID,
        name: 'Current UI prepared fixture',
        fieldsToAnnotate: ['cell_type'],
        annotatableSettings: {
          cell_type: { minAnnotators: 1, threshold: 0.5 },
        },
        closedFields: [],
      },
      {
        datasetId: SECOND_DATASET_ID,
        name: SECOND_DATASET_NAME,
        fieldsToAnnotate: ['cell_type'],
        annotatableSettings: {
          cell_type: { minAnnotators: 1, threshold: 0.25 },
        },
        closedFields: [],
      },
    ],
  };
}

function configDocumentAtCanonicalBytes(targetBytes) {
  const supportedDatasets = [{
    datasetId: FIRST_DATASET_ID,
    name: 'Current UI prepared fixture',
    fieldsToAnnotate: ['cell_type'],
    annotatableSettings: {
      cell_type: { minAnnotators: 1, threshold: 0 },
    },
    closedFields: [],
  }];
  for (let datasetIndex = 0; datasetIndex < 50; datasetIndex += 1) {
    const fieldsToAnnotate = Array.from(
      { length: 80 },
      (_, fieldIndex) =>
        `f${datasetIndex}_${fieldIndex}_${'x'.repeat(70)}`
    );
    supportedDatasets.push({
      datasetId: `filler-${datasetIndex}`,
      name: `Filler ${datasetIndex}`,
      fieldsToAnnotate,
      annotatableSettings: Object.fromEntries(
        fieldsToAnnotate.map(field => [
          field,
          { minAnnotators: 1, threshold: 0.5 },
        ])
      ),
      closedFields: [],
    });
  }
  const document = { version: 1, supportedDatasets };
  const canonicalBytes = () => Buffer.byteLength(
    `${JSON.stringify(document, null, 2)}\n`,
    'utf8'
  );
  let remaining = targetBytes - canonicalBytes();
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error('Synthetic config target is below its base fixture');
  }

  if (remaining % 2 === 1) {
    supportedDatasets[1].name += 'n';
    remaining -= 1;
  }
  for (
    let datasetIndex = 1;
    datasetIndex < supportedDatasets.length && remaining > 0;
    datasetIndex += 1
  ) {
    const entry = supportedDatasets[datasetIndex];
    for (
      let fieldIndex = 0;
      fieldIndex < entry.fieldsToAnnotate.length && remaining > 0;
      fieldIndex += 1
    ) {
      const current = entry.fieldsToAnnotate[fieldIndex];
      const addedCharacters = Math.min(
        256 - current.length,
        remaining / 2
      );
      if (addedCharacters < 1) continue;
      const next = `${current}${'y'.repeat(addedCharacters)}`;
      const setting = entry.annotatableSettings[current];
      delete entry.annotatableSettings[current];
      entry.annotatableSettings[next] = setting;
      entry.fieldsToAnnotate[fieldIndex] = next;
      remaining -= addedCharacters * 2;
    }
  }
  if (remaining !== 0 || canonicalBytes() !== targetBytes) {
    throw new Error('Synthetic config could not reach its exact byte target');
  }
  return document;
}

function userDocument() {
  return {
    version: 1,
    username: AUTH_USER_KEY,
    githubUserId: AUTH_USER.id,
    login: AUTH_USER.login,
    displayName: 'Reconnect Tester',
    updatedAt: '2026-07-29T00:00:00.000Z',
    suggestions: {},
    votes: {},
  };
}

function schemaDocument(kind) {
  const ids = {
    user:
      'https://cellucid.com/contracts/community-annotation/user-v1.schema.json',
    config:
      'https://cellucid.com/contracts/community-annotation/config-v1.schema.json',
    merges:
      'https://cellucid.com/contracts/community-annotation/merges-v1.schema.json',
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: ids[kind],
  };
}

function githubContent(document, shaCharacter) {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(document), 'utf8').toString('base64'),
    sha: shaCharacter.repeat(40),
  };
}

async function installGitHubApi(
  page,
  resolveRepoInfo,
  {
    handleMutation = null,
    resolveContentFile = null,
    resolveUserFile = null,
    userFileExists = true,
  } = {},
) {
  const requests = [];
  await page.route(`${WORKER_ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    requests.push(url.pathname);
    if (method === 'GET' && url.pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(workerCapabilityDocument()),
      });
      return;
    }
    if (method !== 'GET') {
      if (typeof handleMutation !== 'function') {
        throw new Error(
          `Unexpected synthetic GitHub mutation: ${method} ${url.pathname}`,
        );
      }
      await handleMutation({ method, request, route, url });
      return;
    }
    if (url.pathname === '/auth/user') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(AUTH_USER),
      });
      return;
    }
    const repoMatch = url.pathname.match(
      /^\/api\/repos\/([^/]+)\/([^/]+)$/,
    );
    if (repoMatch) {
      const fullName =
        `${decodeURIComponent(repoMatch[1])}/${decodeURIComponent(repoMatch[2])}`;
      const response = await resolveRepoInfo(fullName);
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        headers: response.headers,
        body: JSON.stringify(response.body),
      });
      return;
    }
    if (
      /^\/api\/repos\/[^/]+\/[^/]+\/git\/trees\/[^/]+$/.test(
        url.pathname,
      )
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tree: [
            {
              type: 'tree',
              path: 'annotations/users',
              sha: 'd'.repeat(40),
            },
            {
              type: 'blob',
              path: 'annotations/users/.gitkeep',
              sha: EMPTY_USERS_SENTINEL_SHA,
              size: 1,
            },
          ],
          truncated: false,
        }),
      });
      return;
    }

    const contentPath = decodeURIComponent(
      url.pathname.replace(
        /^\/api\/repos\/[^/]+\/[^/]+\/contents\//,
        '',
      ),
    );
    if (typeof resolveContentFile === 'function') {
      const resolved = await resolveContentFile(contentPath);
      if (resolved !== undefined) {
        if (resolved === null) {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Not Found' }),
          });
          return;
        }
        if (
          !resolved ||
          typeof resolved !== 'object' ||
          typeof resolved.text !== 'string' ||
          typeof resolved.sha !== 'string'
        ) {
          throw new Error(
            'Synthetic GitHub content resolver returned an invalid file',
          );
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(resolved.text, 'utf8').toString('base64'),
            sha: resolved.sha,
          }),
        });
        return;
      }
    }
    let document;
    let shaCharacter;
    if (contentPath === 'annotations/schema.json') {
      document = schemaDocument('user');
      shaCharacter = 'a';
    } else if (contentPath === 'annotations/config.schema.json') {
      document = schemaDocument('config');
      shaCharacter = 'b';
    } else if (
      contentPath === 'annotations/moderation/merges.schema.json'
    ) {
      document = schemaDocument('merges');
      shaCharacter = 'c';
    } else if (contentPath === 'annotations/config.json') {
      document = configDocument();
      shaCharacter = 'd';
    } else if (
      contentPath === `annotations/users/${AUTH_USER_KEY}.json`
    ) {
      if (typeof resolveUserFile === 'function') {
        const resolved = await resolveUserFile();
        if (resolved !== null) {
          if (
            !resolved ||
            typeof resolved !== 'object' ||
            typeof resolved.text !== 'string' ||
            typeof resolved.sha !== 'string'
          ) {
            throw new Error(
              'Synthetic GitHub user-file resolver returned an invalid file',
            );
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(resolved.text, 'utf8').toString('base64'),
              sha: resolved.sha,
            }),
          });
          return;
        }
      }
      if (!userFileExists) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Not Found' }),
        });
        return;
      }
      document = userDocument();
      shaCharacter = 'e';
    } else if (
      contentPath === 'annotations/moderation/merges.json'
    ) {
      document = {
        version: 1,
        updatedAt: '2026-07-29T00:00:00.000Z',
        merges: [],
      };
      shaCharacter = 'f';
    } else {
      throw new Error(`Unexpected synthetic GitHub request: ${url}`);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(githubContent(document, shaCharacter)),
    });
  });
  return requests;
}

async function installAlternatePreparedDataset(page) {
  await page.route(
    '**/tests/browser/fixtures/exports/datasets.json',
    async route => {
      const response = await route.fetch();
      const catalog = await response.json();
      const source = catalog.datasets.find(
        dataset => dataset.id === FIRST_DATASET_ID,
      );
      if (source === undefined) {
        throw new Error('Prepared fixture is missing from its dataset catalog.');
      }
      catalog.datasets.push({
        ...source,
        id: SECOND_DATASET_ID,
        name: SECOND_DATASET_NAME,
        path: `${SECOND_DATASET_ID}/`,
      });
      await route.fulfill({ response, json: catalog });
    },
  );

  await page.route(
    `**/tests/browser/fixtures/exports/${SECOND_DATASET_ID}/**`,
    async route => {
      const alternateUrl = new URL(route.request().url());
      const preparedUrl = new URL(alternateUrl);
      const alternatePrefix =
        `/tests/browser/fixtures/exports/${SECOND_DATASET_ID}/`;
      preparedUrl.pathname =
        `/tests/browser/fixtures/exports/${FIRST_DATASET_ID}/` +
        alternateUrl.pathname.slice(alternatePrefix.length);
      const response = await route.fetch({ url: preparedUrl.href });
      if (alternateUrl.pathname.endsWith('/dataset_identity.json')) {
        const identity = await response.json();
        identity.id = SECOND_DATASET_ID;
        identity.name = SECOND_DATASET_NAME;
        await route.fulfill({ response, json: identity });
        return;
      }
      await route.fulfill({ response });
    },
  );
}

async function installPrototypeNamedPreparedField(page) {
  await page.route(
    '**/current-ui-prepared/dataset_identity.json',
    async route => {
      const response = await route.fetch();
      const identity = await response.json();
      const categorical = identity.obs_fields.find(
        field => field.key === 'cell_type',
      );
      if (categorical === undefined) {
        throw new Error('Prepared fixture is missing its categorical field.');
      }
      categorical.key = '__proto__';
      await route.fulfill({ response, json: identity });
    },
  );
  await page.route(
    '**/current-ui-prepared/obs_manifest.json',
    async route => {
      const response = await route.fetch();
      const manifest = await response.json();
      const categorical = manifest._categoricalFields.find(
        field => field[1] === 'cell_type',
      );
      if (categorical === undefined) {
        throw new Error('Prepared manifest is missing its categorical field.');
      }
      // A field name is no longer part of any path, so renaming it to a
      // prototype key leaves the payload where the manifest's index says.
      categorical[1] = '__proto__';
      await route.fulfill({ response, json: manifest });
    },
  );
}

function deepLink(repo = FIRST_REPO, { includeBranch = true } = {}) {
  const annotationReference = includeBranch ? `${repo}@main` : repo;
  return (
    `/?exportsBaseUrl=${encodeURIComponent(EXPORTS_ROOT)}` +
    `&dataset=${encodeURIComponent(FIRST_DATASET_ID)}` +
    `&annotations=${encodeURIComponent(annotationReference)}` +
    '&acceptance=community-annotation-startup-lifecycle'
  );
}

async function runtimeSnapshot(page) {
  return page.evaluate(async () => {
    const [
      { getCommunityAnnotationAccessStore },
      { getCommunityAnnotationFileCache },
      { getGitHubAuthSession },
      { getCommunityAnnotationSession },
      { getAnnotationRepoForDataset },
      { getDataSourceManager },
    ] = await Promise.all([
      import('/assets/js/app/community-annotations/access-store.js'),
      import('/assets/js/app/community-annotations/file-cache.js'),
      import('/assets/js/app/community-annotations/github-auth.js'),
      import('/assets/js/app/community-annotations/session.js'),
      import('/assets/js/app/community-annotations/repo-store.js'),
      import('/assets/js/data/data-source-manager.js'),
    ]);
    const session = getCommunityAnnotationSession();
    const auth = getGitHubAuthSession();
    const currentDatasetId =
      getDataSourceManager().getCurrentDatasetId();
    return {
      authenticated: auth.isAuthenticated(),
      currentDatasetId,
      session: {
        datasetId: session.getDatasetId(),
        repoRef: session.getRepoRef(),
        userId: session.getCacheUserId(),
        profile: session.getProfile(),
      },
      role: getCommunityAnnotationAccessStore().getRole(),
      cacheMode: getCommunityAnnotationFileCache().getCacheMode(),
      currentRepo:
        currentDatasetId === null
          ? null
          : getAnnotationRepoForDataset(
            currentDatasetId,
              auth.isAuthenticated() ? `ghid_${auth.getUser().id}` : 'local',
            ),
      reposByDataset: auth.isAuthenticated()
        ? {
            first: getAnnotationRepoForDataset(
              'current-ui-prepared',
              `ghid_${auth.getUser().id}`,
            ),
            second: getAnnotationRepoForDataset(
              'current-ui-alternate',
              `ghid_${auth.getUser().id}`,
            ),
          }
        : { first: null, second: null },
      annotationParam:
        new URL(window.location.href).searchParams.get('annotations'),
    };
  });
}

async function openPreparedDeepLink(page) {
  await page.goto(deepLink(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
}

async function openPreparedWithoutAnnotationRepo(page) {
  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(EXPORTS_ROOT)}` +
      `&dataset=${encodeURIComponent(FIRST_DATASET_ID)}` +
      '&acceptance=community-annotation-github-discovery-lifecycle',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
}

async function openGitHubSetupFromMainControls(page) {
  const section = page.locator('#community-annotation-section');
  if (!(await section.evaluate(element => element.open))) {
    await section.locator(':scope > summary').click();
  }
  await section.getByRole('button', {
    name: 'Connect repo',
    exact: true,
  }).click();
  const modal = page.getByRole('dialog', {
    name: 'GitHub sync',
    exact: true,
  });
  await expect(modal).toBeVisible();
  return modal;
}

function waitForRepoRequestFailure(page, repo) {
  const path = `/api/repos/${repo}`;
  return page.waitForEvent('requestfailed', request => {
    const url = new URL(request.url());
    return url.origin === WORKER_ORIGIN && url.pathname === path;
  });
}

function waitForWorkerRequestFailure(
  page,
  { path, method, timeout = 10_000 },
) {
  return page.waitForEvent('requestfailed', {
    predicate: request => {
      const url = new URL(request.url());
      return (
        url.origin === WORKER_ORIGIN &&
        url.pathname === path &&
        request.method() === method
      );
    },
    timeout,
  });
}

async function settleBrowserContinuations(page) {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function startGitHubPublication(page) {
  await page.evaluate(async ({ login, userId, userKey }) => {
    const { getCommunityAnnotationSession } =
      await import('/assets/js/app/community-annotations/session.js');
    getCommunityAnnotationSession().setProfile({
      username: userKey,
      login,
      githubUserId: userId,
      displayName: 'Publication Lifecycle Tester',
      title: '',
      orcid: '',
      linkedin: '',
    });
  }, {
    login: AUTH_USER.login,
    userId: AUTH_USER.id,
    userKey: AUTH_USER_KEY,
  });
  const section = page.locator('#community-annotation-section');
  if (!(await section.evaluate(element => element.open))) {
    await section.locator(':scope > summary').click();
  }
  await section.getByRole('button', {
    name: 'GitHub sync…',
    exact: true,
  }).click();
  const modal = page.locator('.community-annotation-modal-overlay').last();
  await expect(modal).toBeVisible();
  const publish = modal.getByRole('button', {
    name: 'Publish',
    exact: true,
  });
  await expect(publish).toBeEnabled();
  await publish.click();
  return { modal, publish };
}

async function runExactAuthorBaselineLifecycle(page, target) {
  const paths = {
    config: 'annotations/config.json',
    merges: 'annotations/moderation/merges.json',
    user: `annotations/users/${AUTH_USER_KEY}.json`,
  };
  const firstShas = {
    config: '2'.repeat(40),
    merges: '3'.repeat(40),
    user: '1'.repeat(40),
  };
  const secondSha = '4'.repeat(40);
  const remoteFiles = new Map([
    [
      paths.config,
      {
        text: `${JSON.stringify(configDocument(), null, 2)}\n`,
        sha: firstShas.config,
      },
    ],
    [
      paths.merges,
      {
        text: `${JSON.stringify({
          version: 1,
          updatedAt: '2026-07-29T00:00:00.000Z',
          merges: [],
        }, null, 2)}\n`,
        sha: firstShas.merges,
      },
    ],
    [paths.user, null],
  ]);
  const mutationRequests = [];

  await installStoredAuthentication(page);
  await installGitHubApi(
    page,
    async fullName => ({
      body: repoInfo(fullName, { author: true }),
    }),
    {
      resolveContentFile: async path => (
        remoteFiles.has(path) ? remoteFiles.get(path) : undefined
      ),
      handleMutation: async ({ method, request, route, url }) => {
        const requestHeaders = await request.allHeaders();
        const operationId =
          requestHeaders[OPERATION_ID_HEADER] ?? null;
        mutationRequests.push({
          body: JSON.parse(request.postData() ?? 'null'),
          method,
          operationId,
          path: url.pathname,
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {
            'access-control-expose-headers':
              'X-Cellucid-Operation-Id, X-Cellucid-Operation-Outcome',
            'x-cellucid-operation-id': operationId ?? '',
            'x-cellucid-operation-outcome': 'applied',
          },
          body: JSON.stringify({
            content: { sha: secondSha },
          }),
        });
      },
    },
  );

  await openPreparedDeepLink(page);
  await expect.poll(() => runtimeSnapshot(page), {
    timeout: 10_000,
  }).toMatchObject({
    authenticated: true,
    role: 'author',
    currentRepo: `${FIRST_REPO}@main`,
  });

  const exactDocuments = await page.evaluate(
    async ({ login, userId, userKey }) => {
      const { getCommunityAnnotationSession } =
        await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      session.setProfile({
        username: userKey,
        login,
        githubUserId: userId,
        displayName: 'Author Baseline Tester',
        title: '',
        orcid: '',
        linkedin: '',
      });
      session.setFieldAnnotated('cell_type', true);
      session.setAnnotatableConsensusSettings('cell_type', {
        minAnnotators: 1,
        threshold: 0.5,
      });
      session.setClosedAnnotatableFields([]);
      session.setModerationMergesFromDoc({
        version: 1,
        updatedAt: '2026-07-29T00:00:00.000Z',
        merges: [],
      });
      const user = session.buildUserFileDocument({
        githubUserId: userId,
      });
      const merges = session.buildModerationMergesDocument();
      session.buildUserFileDocument = () =>
        JSON.parse(JSON.stringify(user));
      session.buildModerationMergesDocument = () =>
        JSON.parse(JSON.stringify(merges));
      return { merges, user };
    },
    {
      login: AUTH_USER.login,
      userId: AUTH_USER.id,
      userKey: AUTH_USER_KEY,
    },
  );
  remoteFiles.set(paths.user, {
    text: `${JSON.stringify(exactDocuments.user, null, 2)}\n`,
    sha: firstShas.user,
  });
  remoteFiles.set(paths.merges, {
    text: `${JSON.stringify(exactDocuments.merges, null, 2)}\n`,
    sha: firstShas.merges,
  });

  const { modal, publish } = await startGitHubPublication(page);
  const status = modal.getByRole('status');
  await expect(status).toHaveText('Publish complete.', {
    timeout: 10_000,
  });
  expect(mutationRequests).toHaveLength(0);
  const baselineAfterNoOp = await page.evaluate(async path => {
    const { getCommunityAnnotationSession } =
      await import('/assets/js/app/community-annotations/session.js');
    return getCommunityAnnotationSession().getRemoteFileShas()[path] ?? null;
  }, paths[target]);

  await page.evaluate(async selectedTarget => {
    const { getCommunityAnnotationSession } =
      await import('/assets/js/app/community-annotations/session.js');
    const session = getCommunityAnnotationSession();
    if (selectedTarget === 'config') {
      session.setAnnotatableConsensusSettings('cell_type', {
        minAnnotators: 1,
        threshold: 0.75,
      });
      return;
    }
    delete session.buildModerationMergesDocument;
    session.setModerationMergesFromDoc({
      version: 1,
      updatedAt: '2026-07-29T00:00:01.000Z',
      merges: [
        {
          bucket: 'cell_type:Alpha',
          fromSuggestionId: 'from-suggestion',
          intoSuggestionId: 'into-suggestion',
          by: 'ghid_4242',
          at: '2026-07-29T00:00:01.000Z',
        },
      ],
    });
  }, target);
  await expect(publish).toBeEnabled();
  await publish.click();

  let secondOutcome = 'pending';
  await expect.poll(async () => {
    const statusText = await status.textContent();
    secondOutcome = mutationRequests.length === 1
      ? 'mutation-dispatched'
      : (
        /Missing baseline version/.test(statusText ?? '')
          ? 'missing-baseline-conflict'
          : 'pending'
      );
    return secondOutcome;
  }, { timeout: 10_000 }).not.toBe('pending');

  expect(
    baselineAfterNoOp,
    `${target} second publication outcome: ${secondOutcome}`,
  ).toBe(firstShas[target]);
  expect(mutationRequests).toHaveLength(1);
  await expect(status).toHaveText('Publish complete.', {
    timeout: 10_000,
  });
  expect(mutationRequests[0]).toMatchObject({
    method: 'PUT',
    path: `/api/repos/${FIRST_REPO}/contents/${paths[target]}`,
    body: { sha: firstShas[target] },
  });
  expect(mutationRequests[0].operationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const finalBaseline = await page.evaluate(async path => {
    const { getCommunityAnnotationSession } =
      await import('/assets/js/app/community-annotations/session.js');
    return getCommunityAnnotationSession().getRemoteFileShas()[path] ?? null;
  }, paths[target]);
  expect(finalBaseline).toBe(secondSha);
}

test(
  'stored-auth deep link initializes cache and identity before role settlement',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    const repoRequested = deferred();
    const releaseRepo = deferred();
    await installGitHubApi(page, async fullName => {
      repoRequested.resolve();
      await releaseRepo.promise;
      return {
        body: repoInfo(fullName, { author: true }),
      };
    });

    await openPreparedDeepLink(page);
    await repoRequested.promise;

    try {
      await expect.poll(() => runtimeSnapshot(page), {
        timeout: 10_000,
      }).toMatchObject({
        authenticated: true,
        session: {
          datasetId: FIRST_DATASET_ID,
          repoRef: `${FIRST_REPO}@main`,
          userId: AUTH_USER.id,
          profile: {
            username: AUTH_USER_KEY,
            login: AUTH_USER.login,
            githubUserId: AUTH_USER.id,
          },
        },
        cacheMode: 'indexeddb',
        currentRepo: `${FIRST_REPO}@main`,
      });
      expect(productErrors).toEqual([]);
    } finally {
      releaseRepo.resolve();
    }
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
      },
      currentRepo: `${FIRST_REPO}@main`,
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'stale Worker capability blocks browser sign-in before redirect or token exposure',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    const workerRequests = [];
    await page.addInitScript(workerOrigin => {
      window.__CELLUCID_GITHUB_WORKER_ORIGIN__ = workerOrigin;
      sessionStorage.removeItem(
        'cellucid:github-app-auth:session'
      );
    }, WORKER_ORIGIN);
    await installWorkerCapability(page, {
      status: 'ok',
      service: 'Cellucid GitHub Auth',
      contractVersion: 1,
      endpoints: [
        '/auth/login',
        '/auth/callback',
        '/auth/user',
        '/auth/installations',
        '/auth/installation-repos',
        '/auth/installation-token',
      ],
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== WORKER_ORIGIN) return;
      workerRequests.push({
        authorization:
          request.headers().authorization ?? null,
        method: request.method(),
        path: url.pathname,
      });
    });

    await openPreparedWithoutAnnotationRepo(page);
    const startingUrl = page.url();
    const modal = await openGitHubSetupFromMainControls(page);
    await modal.getByRole('button', {
      name: 'Continue with GitHub',
      exact: true,
    }).click();
    await expect(modal.getByRole('status')).toContainText(
      'not compatible with this Cellucid client'
    );
    await expect(modal).toBeVisible();
    expect(page.url()).toBe(startingUrl);
    expect(workerRequests).toEqual([{
      authorization: null,
      method: 'GET',
      path: '/',
    }]);
    const storedAuth = await page.evaluate(() =>
      sessionStorage.getItem(
        'cellucid:github-app-auth:session'
      )
    );
    expect(storedAuth).toBeNull();
    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    expect(productErrors).toEqual([]);
  },
);

test(
  'stale Worker preserves a restored repository before any token-bearing request',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    const workerRequests = [];
    await page.addInitScript(({
      datasetId,
      repoRef,
      user,
      userKey,
      workerOrigin,
    }) => {
      window.__CELLUCID_GITHUB_WORKER_ORIGIN__ = workerOrigin;
      sessionStorage.setItem(
        'cellucid:github-app-auth:session',
        JSON.stringify({
          token: 'synthetic-restored-token',
          user,
        }),
      );
      localStorage.setItem(
        'cellucid:community-annotations:repo-map',
        JSON.stringify({
          [`${datasetId}::${userKey}`]: {
            repoRef,
            branchMode: 'default',
          },
        }),
      );
    }, {
      datasetId: FIRST_DATASET_ID,
      repoRef: `${FIRST_REPO}@main`,
      user: AUTH_USER,
      userKey: AUTH_USER_KEY,
      workerOrigin: WORKER_ORIGIN,
    });
    await page.route(`${WORKER_ORIGIN}/`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...workerCapabilityDocument(),
          contractVersion: 0,
        }),
      });
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== WORKER_ORIGIN) return;
      workerRequests.push({
        authorization:
          request.headers().authorization ?? null,
        method: request.method(),
        path: url.pathname,
      });
    });

    await openPreparedWithoutAnnotationRepo(page);
    await expect(
      page.locator('.notification-error').last()
    ).toContainText(
      'Deploy the matching Cellucid Worker, then retry GitHub sync.',
    );
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      currentRepo: `${FIRST_REPO}@main`,
      role: 'unknown',
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
      },
    });
    expect(workerRequests).toEqual([{
      authorization: null,
      method: 'GET',
      path: '/',
    }]);
    expect(productErrors).toEqual([]);
  },
);

test(
  'closing GitHub setup aborts the exact in-flight installation discovery without detached updates',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    const installationEntered = deferred();
    const releaseInstallation = deferred();
    const discoveryRequests = [];

    await page.route(
      `${WORKER_ORIGIN}/auth/installations`,
      async route => {
        discoveryRequests.push({
          method: route.request().method(),
          path: new URL(route.request().url()).pathname,
        });
        installationEntered.resolve();
        await releaseInstallation.promise;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            installations: [
              { id: 71, account: { login: 'team' } },
            ],
          }),
        });
      },
    );
    await page.route(
      `${WORKER_ORIGIN}/auth/installation-repos`,
      async route => {
        discoveryRequests.push({
          method: route.request().method(),
          path: new URL(route.request().url()).pathname,
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ repositories: [] }),
        });
      },
    );

    await openPreparedWithoutAnnotationRepo(page);
    const modal = await openGitHubSetupFromMainControls(page);
    await installationEntered.promise;
    await modal.evaluate(overlay => {
      window.__cellucidDetachedDiscoveryProbe = {
        overlay,
        htmlAtDetach: null,
      };
    });
    const requestFailed = waitForWorkerRequestFailure(page, {
      path: '/auth/installations',
      method: 'GET',
    });

    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    await expect(modal).toHaveCount(0);
    await page.evaluate(() => {
      const probe = window.__cellucidDetachedDiscoveryProbe;
      probe.htmlAtDetach = probe.overlay.innerHTML;
    });
    releaseInstallation.resolve();
    await requestFailed;
    await settleBrowserContinuations(page);

    const detachedMarkupStable = await page.evaluate(() => {
      const probe = window.__cellucidDetachedDiscoveryProbe;
      const stable = (
        probe.overlay.innerHTML === probe.htmlAtDetach
      );
      delete window.__cellucidDetachedDiscoveryProbe;
      return stable;
    });
    expect(discoveryRequests).toEqual([
      { method: 'GET', path: '/auth/installations' },
    ]);
    expect(detachedMarkupStable).toBe(true);
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'dataset context retirement closes GitHub setup and aborts its exact discovery owner',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installAlternatePreparedDataset(page);
    const installationEntered = deferred();
    const releaseInstallation = deferred();
    let repositoryRequests = 0;
    await page.route(
      `${WORKER_ORIGIN}/auth/installations`,
      async route => {
        installationEntered.resolve();
        await releaseInstallation.promise;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            installations: [
              { id: 72, account: { login: 'team' } },
            ],
          }),
        });
      },
    );
    await page.route(
      `${WORKER_ORIGIN}/auth/installation-repos`,
      async route => {
        repositoryRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ repositories: [] }),
        });
      },
    );

    await openPreparedWithoutAnnotationRepo(page);
    const modal = await openGitHubSetupFromMainControls(page);
    await installationEntered.promise;
    const requestFailed = waitForWorkerRequestFailure(page, {
      path: '/auth/installations',
      method: 'GET',
    });
    await page.locator('#dataset-select').selectOption(
      SECOND_DATASET_OPTION,
    );
    await expect(page.locator('#dataset-name')).toHaveText(
      SECOND_DATASET_NAME,
    );
    await expect(modal).toHaveCount(0);
    releaseInstallation.resolve();
    await requestFailed;
    await settleBrowserContinuations(page);

    expect(repositoryRequests).toBe(0);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      currentDatasetId: SECOND_DATASET_ID,
      session: {
        datasetId: SECOND_DATASET_ID,
        repoRef: null,
        userId: AUTH_USER.id,
      },
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'destroying GitHub setup aborts the exact in-flight repository discovery and stops later installations',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    const repositoryEntered = deferred();
    const releaseRepository = deferred();
    const repositoryRequests = [];

    await page.route(
      `${WORKER_ORIGIN}/auth/installations`,
      async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            installations: [
              { id: 81, account: { login: 'team-one' } },
              { id: 82, account: { login: 'team-two' } },
            ],
          }),
        });
      },
    );
    await page.route(
      `${WORKER_ORIGIN}/auth/installation-repos`,
      async route => {
        const request = route.request();
        const body = JSON.parse(request.postData() ?? 'null');
        repositoryRequests.push({
          body,
          method: request.method(),
          path: new URL(request.url()).pathname,
        });
        if (repositoryRequests.length === 1) {
          repositoryEntered.resolve();
          await releaseRepository.promise;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ repositories: [] }),
        });
      },
    );

    await openPreparedWithoutAnnotationRepo(page);
    await page.evaluate(async datasetId => {
      const { initCommunityAnnotationControls } = await import(
        '/assets/js/app/ui/modules/community-annotation-controls.js'
      );
      const container = document.createElement('div');
      container.id = 'synthetic-github-discovery-controls';
      document.body.appendChild(container);
      const controls = initCommunityAnnotationControls({
        state: {
          getFields() {
            return [];
          },
        },
        dom: { container },
        dataSourceManager: {
          getCurrentDatasetId() {
            return datasetId;
          },
          onDatasetChange() {},
          offDatasetChange() {},
        },
        infoPopovers: {
          closeWithin() {},
          configurePair() {},
        },
      });
      const connect = [...container.querySelectorAll('button')].find(
        button => button.textContent === 'Connect repo',
      );
      if (!(connect instanceof HTMLButtonElement)) {
        throw new Error('Synthetic GitHub setup control is unavailable');
      }
      window.__cellucidSyntheticDiscoveryControls = {
        container,
        controls,
      };
      connect.click();
    }, FIRST_DATASET_ID);
    const modal = page.getByRole('dialog', {
      name: 'GitHub sync',
      exact: true,
    });
    await expect(modal).toBeVisible();
    await repositoryEntered.promise;
    expect(repositoryRequests).toEqual([
      {
        body: { installation_id: 81 },
        method: 'POST',
        path: '/auth/installation-repos',
      },
    ]);
    await modal.evaluate(overlay => {
      window.__cellucidDetachedDiscoveryProbe = {
        overlay,
        htmlAtDetach: null,
      };
    });
    const requestFailed = waitForWorkerRequestFailure(page, {
      path: '/auth/installation-repos',
      method: 'POST',
    });

    await page.evaluate(() => {
      window.__cellucidSyntheticDiscoveryControls.controls.destroy();
    });
    await expect(modal).toHaveCount(0);
    await page.evaluate(() => {
      const probe = window.__cellucidDetachedDiscoveryProbe;
      probe.htmlAtDetach = probe.overlay.innerHTML;
    });
    releaseRepository.resolve();
    await requestFailed;
    await settleBrowserContinuations(page);

    const detachedMarkupStable = await page.evaluate(() => {
      const probe = window.__cellucidDetachedDiscoveryProbe;
      const stable = (
        probe.overlay.innerHTML === probe.htmlAtDetach
      );
      delete window.__cellucidDetachedDiscoveryProbe;
      const owner = window.__cellucidSyntheticDiscoveryControls;
      owner.container.remove();
      delete window.__cellucidSyntheticDiscoveryControls;
      return stable;
    });
    expect(repositoryRequests).toEqual([
      {
        body: { installation_id: 81 },
        method: 'POST',
        path: '/auth/installation-repos',
      },
    ]);
    expect(detachedMarkupStable).toBe(true);
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  '10k-repository chooser bounds active DOM, paging, filtering, and focus',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    const repositoryRequests = [];
    await page.route(
      `${WORKER_ORIGIN}/auth/installations`,
      async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            installations: [
              { id: 501, account: { login: 'large-team' } },
            ],
          }),
        });
      },
    );
    await page.route(
      `${WORKER_ORIGIN}/auth/installation-repos`,
      async route => {
        const body = JSON.parse(route.request().postData() ?? 'null');
        repositoryRequests.push(body.installation_id);
        const repositories = Array.from({ length: 10_000 }, (_, index) => {
          const focusRepo = index < 101;
          const suffix = focusRepo
            ? `focus-${String(index).padStart(3, '0')}`
            : `repo-${String(index).padStart(5, '0')}`;
          return {
            id: index + 1,
            full_name: `large-team/${suffix}`,
            private: index % 2 === 0,
          };
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ repositories }),
        });
      },
    );

    await openPreparedWithoutAnnotationRepo(page);
    const modal = await openGitHubSetupFromMainControls(page);
    const step2Grid = modal.locator(
      '[aria-label="Available annotation repositories"]'
    );
    const step3Grid = modal.locator(
      '[aria-label="Selectable annotation repositories"]'
    );
    const step2Status = modal.locator(
      '[aria-label="available repositories pagination"] ' +
      '.community-annotation-repo-page-status'
    );
    const step3Status = modal.locator(
      '[aria-label="selectable repositories pagination"] ' +
      '.community-annotation-repo-page-status'
    );

    await expect(step2Status).toHaveText(
      'Showing 1–100 of 10000 repositories. Page 1 of 100.',
      { timeout: 15_000 }
    );
    await expect(
      step2Grid.locator('.community-annotation-repo-card')
    ).toHaveCount(100);
    await expect(
      step3Grid.locator('.community-annotation-repo-card')
    ).toHaveCount(0);
    await expect(
      modal.locator('.community-annotation-repo-card')
    ).toHaveCount(100);
    expect(repositoryRequests).toEqual([501]);

    await modal.locator('.community-annotation-wizard-next').click();
    await expect(
      step2Grid.locator('.community-annotation-repo-card')
    ).toHaveCount(0);
    await expect(
      step3Grid.locator('.community-annotation-repo-card')
    ).toHaveCount(100);
    await expect(
      modal.locator('.community-annotation-repo-card')
    ).toHaveCount(100);

    const filter = modal.getByRole('textbox', {
      name: 'Filter repositories',
      exact: true,
    });
    await filter.fill('focus-');
    await expect(step3Status).toHaveText(
      'Showing 1–100 of 101 repositories. Page 1 of 2.'
    );
    await expect(
      step3Grid.locator('.community-annotation-repo-card')
    ).toHaveCount(100);
    await expect(filter).toBeFocused();

    const nextPage = modal.getByRole('button', {
      name: 'Next selectable repositories page',
      exact: true,
    });
    const previousPage = modal.getByRole('button', {
      name: 'Previous selectable repositories page',
      exact: true,
    });
    await expect(
      modal.getByRole('group', {
        name: 'selectable repositories pagination',
        exact: true,
      })
    ).toBeVisible();
    await nextPage.click();
    await expect(step3Status).toHaveText(
      'Showing 101–101 of 101 repositories. Page 2 of 2.'
    );
    await expect(
      step3Grid.locator('.community-annotation-repo-card')
    ).toHaveCount(1);
    await expect(nextPage).toBeDisabled();
    await expect(previousPage).toBeFocused();

    await filter.fill('focus-100');
    await expect(step3Status).toHaveText(
      'Showing 1–1 of 1 repositories. Page 1 of 1.'
    );
    await expect(
      step3Grid.locator('.community-annotation-repo-card')
    ).toHaveCount(1);
    await expect(filter).toBeFocused();
    await filter.fill('repository-that-does-not-exist');
    await expect(step3Status).toHaveText('No repositories to display.');
    await expect(
      step3Grid.locator('.community-annotation-repo-card')
    ).toHaveCount(0);
    await expect(step3Grid).toContainText(
      'No repositories match this filter.'
    );

    await filter.fill('');
    const firstCard = step3Grid.locator(
      '[data-repo-full-name="large-team/focus-000"]'
    );
    await expect(firstCard).toBeVisible();
    await firstCard.evaluate(card => {
      window.__cellucidRepoCardIdentity = card;
    });
    await filter.evaluate(input => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      await firstCard.evaluate(
        card => card === window.__cellucidRepoCardIdentity
      )
    ).toBe(true);

    await firstCard.click();
    await expect(firstCard).toHaveAttribute('aria-pressed', 'true');
    await expect(firstCard).toBeFocused();
    await firstCard.press('Space');
    await expect(firstCard).toHaveAttribute('aria-pressed', 'false');
    await expect(firstCard).toBeFocused();
    await firstCard.click();
    await expect(firstCard).toHaveAttribute('aria-pressed', 'true');
    await expect(firstCard).toBeFocused();
    await expect(
      modal.locator('.community-annotation-repo-card')
    ).toHaveCount(100);
    await expect(
      modal.locator('.legend-help').filter({
        hasText: 'Selected: large-team/focus-000',
      })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'aggregate repository discovery rejects the 10001st item without truncation',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    const repositoryRequests = [];
    await page.route(
      `${WORKER_ORIGIN}/auth/installations`,
      async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            installations: [
              { id: 601, account: { login: 'first-team' } },
              { id: 602, account: { login: 'second-team' } },
            ],
          }),
        });
      },
    );
    await page.route(
      `${WORKER_ORIGIN}/auth/installation-repos`,
      async route => {
        const body = JSON.parse(route.request().postData() ?? 'null');
        repositoryRequests.push(body.installation_id);
        const firstInstallation = body.installation_id === 601;
        const count = firstInstallation ? 5_000 : 5_001;
        const offset = firstInstallation ? 0 : 5_000;
        const owner = firstInstallation ? 'first-team' : 'second-team';
        const repositories = Array.from({ length: count }, (_, index) => ({
          id: offset + index + 1,
          full_name:
            `${owner}/repo-${String(index).padStart(5, '0')}`,
          private: false,
        }));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ repositories }),
        });
      },
    );

    await openPreparedWithoutAnnotationRepo(page);
    const modal = await openGitHubSetupFromMainControls(page);
    const status = modal.locator(
      '.community-annotation-wizard-status'
    );
    await expect(status).toHaveText(
      'Cellucid found more than 10,000 repositories across your GitHub ' +
      'App installations, which it will not truncate. In GitHub App ' +
      'settings, select fewer repositories, then click Reload.',
      { timeout: 15_000 }
    );
    expect(repositoryRequests).toEqual([601, 602]);
    await expect(
      modal.locator('.community-annotation-repo-card')
    ).toHaveCount(0);
    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    expect(productErrors).toEqual([]);
  },
);

test(
  'retired repository discovery ignores a deferred non-abort rejection',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await openPreparedWithoutAnnotationRepo(page);
    await page.evaluate(async () => {
      const { getGitHubAuthSession } = await import(
        '/assets/js/app/community-annotations/github-auth.js'
      );
      const auth = getGitHubAuthSession();
      let rejectRepository;
      const repository = new Promise((_resolve, reject) => {
        rejectRepository = reject;
      });
      const probe = {
        entered: false,
        htmlAtDetach: null,
        overlay: null,
        settled: false,
        rejectRepository() {
          rejectRepository(
            new Error('Synthetic non-abort repository schema failure')
          );
        },
      };
      auth.listInstallations = async () => ({
        installations: [
          { id: 701, account: { login: 'retired-team' } },
        ],
      });
      auth.listInstallationRepos = async () => {
        probe.entered = true;
        try {
          return await repository;
        } finally {
          probe.settled = true;
        }
      };
      window.__cellucidRetiredRepoDiscovery = probe;
    });

    const modal = await openGitHubSetupFromMainControls(page);
    await expect.poll(
      () => page.evaluate(
        () => window.__cellucidRetiredRepoDiscovery.entered
      )
    ).toBe(true);
    await modal.evaluate(overlay => {
      window.__cellucidRetiredRepoDiscovery.overlay = overlay;
    });
    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    await expect(modal).toHaveCount(0);
    await page.evaluate(() => {
      const probe = window.__cellucidRetiredRepoDiscovery;
      probe.htmlAtDetach = probe.overlay.innerHTML;
      probe.rejectRepository();
    });
    await expect.poll(
      () => page.evaluate(
        () => window.__cellucidRetiredRepoDiscovery.settled
      )
    ).toBe(true);
    await settleBrowserContinuations(page);
    const detachedMarkupStable = await page.evaluate(() => {
      const probe = window.__cellucidRetiredRepoDiscovery;
      const stable = probe.overlay.innerHTML === probe.htmlAtDetach;
      delete window.__cellucidRetiredRepoDiscovery;
      return stable;
    });
    expect(detachedMarkupStable).toBe(true);
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'GitHub discovery ceiling errors explain how to narrow installations and repositories',
  async ({ page }) => {
    await installStoredAuthentication(page);
    let installationAttempt = 0;
    await page.route(
      `${WORKER_ORIGIN}/auth/installations`,
      async route => {
        installationAttempt += 1;
        if (installationAttempt === 1) {
          await route.fulfill({
            status: 502,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'GitHub installations total_count exceeds 10000',
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            installations: [
              { id: 91, account: { login: 'large-team' } },
            ],
          }),
        });
      },
    );
    await page.route(
      `${WORKER_ORIGIN}/auth/installation-repos`,
      async route => {
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'GitHub repositories total_count exceeds 10000',
          }),
        });
      },
    );

    await openPreparedWithoutAnnotationRepo(page);
    const modal = await openGitHubSetupFromMainControls(page);
    const status = modal.getByRole('status');
    await expect(status).toContainText(
      'Reduce the Cellucid GitHub App installations available to this GitHub account, then click Reload.',
    );

    await modal.getByRole('button', {
      name: 'Reload',
      exact: true,
    }).click();
    await expect(status).toContainText(
      'In GitHub App settings, select fewer repositories for that installation, then click Reload.',
    );
    expect(installationAttempt).toBe(2);
  },
);

test(
  'transient role failure preserves connection and recovers while navigator stays online',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    let reachable = false;
    let repoRequestCount = 0;
    await installGitHubApi(page, async fullName => {
      repoRequestCount++;
      if (!reachable) {
        return {
          status: 503,
          headers: {
            'x-ratelimit-reset': String(
              Math.ceil(Date.now() / 1000) + 2
            ),
          },
          body: { error: 'synthetic worker offline' },
        };
      }
      return {
        body: repoInfo(fullName, { author: true }),
      };
    });

    await openPreparedDeepLink(page);
    await expect.poll(() => repoRequestCount, { timeout: 10_000 }).toBe(1);
    await expect(page.locator('.notification-warning').last()).toContainText(
      'repository connection was preserved',
    );
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'unknown',
      cacheMode: 'indexeddb',
      currentRepo: `${FIRST_REPO}@main`,
      annotationParam: `${FIRST_REPO}@main`,
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
        profile: {
          username: AUTH_USER_KEY,
          githubUserId: AUTH_USER.id,
        },
      },
    });
    expect(withoutExpectedServiceUnavailableConsole(productErrors)).toEqual([]);

    reachable = true;
    await expect.poll(() => repoRequestCount, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
      },
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(withoutExpectedServiceUnavailableConsole(productErrors)).toEqual([]);
  },
);

test(
  'destroy removes the exact dataset-change owner before a later dataset switch',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await page.goto(
      `/?exportsBaseUrl=${encodeURIComponent(EXPORTS_ROOT)}` +
        `&dataset=${encodeURIComponent(FIRST_DATASET_ID)}` +
        '&acceptance=community-annotation-destroy-dataset-owner',
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );

    const result = await page.evaluate(async ({
      firstDatasetId,
      secondDatasetId,
    }) => {
      const { initCommunityAnnotationControls } = await import(
        '/assets/js/app/ui/modules/community-annotation-controls.js'
      );
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      const listeners = new Set();
      let currentDatasetId = firstDatasetId;
      let subscribedListener = null;
      let removedListener = null;
      let onCalls = 0;
      let offCalls = 0;
      const manager = {
        getCurrentDatasetId() {
          return currentDatasetId;
        },
        onDatasetChange(listener) {
          onCalls += 1;
          subscribedListener = listener;
          listeners.add(listener);
        },
        offDatasetChange(listener) {
          offCalls += 1;
          removedListener = listener;
          listeners.delete(listener);
        },
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      const controls = initCommunityAnnotationControls({
        state: {
          getFields() {
            return [];
          },
        },
        dom: { container },
        dataSourceManager: manager,
        infoPopovers: {
          closeWithin() {},
          configurePair() {},
        },
      });
      const session = getCommunityAnnotationSession();
      const beforeDestroy = session.getDatasetId();
      controls.destroy();

      currentDatasetId = secondDatasetId;
      for (const listener of [...listeners]) {
        listener({ datasetId: secondDatasetId });
      }
      const afterSwitch = session.getDatasetId();
      container.remove();
      return {
        beforeDestroy,
        afterSwitch,
        onCalls,
        offCalls,
        listenersRemaining: listeners.size,
        exactListenerRemoved:
          subscribedListener !== null &&
          subscribedListener === removedListener,
      };
    }, {
      firstDatasetId: FIRST_DATASET_ID,
      secondDatasetId: SECOND_DATASET_ID,
    });

    expect(result).toEqual({
      beforeDestroy: FIRST_DATASET_ID,
      afterSwitch: FIRST_DATASET_ID,
      onCalls: 1,
      offCalls: 1,
      listenersRemaining: 0,
      exactListenerRemoved: true,
    });
    expect(productErrors).toEqual([]);
  },
);

test(
  'read-only collaborator keeps Pull and the repository while Publish stays explicitly unavailable',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installGitHubApi(page, async fullName => ({
      body: {
        ...repoInfo(fullName, { author: false }),
        allow_forking: false,
        permissions: {
          pull: true,
          triage: false,
          push: false,
          maintain: false,
          admin: false,
        },
      },
    }));

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'annotator',
      currentRepo: `${FIRST_REPO}@main`,
    });

    const section = page.locator('#community-annotation-section');
    if (!(await section.evaluate(element => element.open))) {
      await section.locator(':scope > summary').click();
    }
    await section.getByRole('button', {
      name: 'GitHub sync…',
      exact: true,
    }).click();
    const modal = page.getByRole('dialog', {
      name: 'GitHub sync',
      exact: true,
    });
    const pull = modal.getByRole('button', {
      name: 'Pull latest',
      exact: true,
    });
    const publish = modal.getByRole('button', {
      name: 'Publish',
      exact: true,
    });
    await expect(pull).toBeEnabled();
    await expect(publish).toBeDisabled();
    await expect(publish).toHaveAttribute(
      'title',
      /do not have permission to publish annotations/
    );

    await pull.click();
    await expect(modal.getByRole('status')).toHaveText(
      'Pulled latest annotations.',
      { timeout: 10_000 }
    );
    await expect(pull).toBeEnabled();
    await expect(publish).toBeDisabled();
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'annotator',
      currentRepo: `${FIRST_REPO}@main`,
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
      },
    });
    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'corrupt raw cache clears its exact scope so reconnect Pull recovers instead of looping',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installGitHubApi(page, async fullName => ({
      body: repoInfo(fullName, { author: true }),
    }));
    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });

    const section = page.locator('#community-annotation-section');
    if (!(await section.evaluate(element => element.open))) {
      await section.locator(':scope > summary').click();
    }
    await section.getByRole('button', {
      name: 'GitHub sync…',
      exact: true,
    }).click();
    let modal = page.getByRole('dialog', {
      name: 'GitHub sync',
      exact: true,
    });
    await modal.getByRole('button', {
      name: 'Pull latest',
      exact: true,
    }).click();
    await expect(modal.getByRole('status')).toHaveText(
      'Pulled latest annotations.',
      { timeout: 10_000 }
    );
    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();

    const beforeCorruption = await page.evaluate(
      async ({ datasetId, repoRef, userId }) => {
        const {
          toFileRecordKey,
          toFileShaIndexKey,
        } = await import(
          '/assets/js/app/community-annotations/cache-scope.js'
        );
        const scope = { datasetId, repoRef, userId };
        const path = 'annotations/moderation/merges.json';
        const indexKey = toFileShaIndexKey(scope);
        const advertised = JSON.parse(
          localStorage.getItem(indexKey) ?? 'null'
        );
        const recordKey = toFileRecordKey(scope, path);
        await new Promise((resolve, reject) => {
          const open = indexedDB.open(
            'cellucid_community_annotation_file_cache',
            1
          );
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(['files'], 'readwrite');
            tx.objectStore('files').delete(recordKey);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(
              tx.error ?? new Error('Synthetic cache deletion aborted')
            );
          };
        });
        return {
          advertisedSha: advertised?.[path] ?? null,
          indexKey,
        };
      },
      {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
      }
    );
    expect(beforeCorruption.advertisedSha).toMatch(/^[0-9a-f]{40}$/);

    await section.getByRole('button', {
      name: 'GitHub sync…',
      exact: true,
    }).click();
    modal = page.getByRole('dialog', {
      name: 'GitHub sync',
      exact: true,
    });
    await modal.getByRole('button', {
      name: 'Pull latest',
      exact: true,
    }).click();
    const cacheRecoveryNotifications =
      page.locator('.notification-error').filter({
        hasText: 'exact local raw-file cache was cleared',
      });
    await expect(cacheRecoveryNotifications).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(cacheRecoveryNotifications).toBeVisible();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => runtimeSnapshot(page)).toMatchObject({
      currentRepo: null,
      session: {
        repoRef: null,
        userId: AUTH_USER.id,
      },
    });
    expect(
      await page.evaluate(
        key => localStorage.getItem(key),
        beforeCorruption.indexKey
      )
    ).toBeNull();

    await page.evaluate(
      async ({ datasetId, repoRef, userKey }) => {
        const [
          { setAnnotationRepoForDataset },
          { setUrlAnnotationRepo },
        ] = await Promise.all([
          import('/assets/js/app/community-annotations/repo-store.js'),
          import('/assets/js/app/url-state.js'),
        ]);
        setAnnotationRepoForDataset(
          datasetId,
          repoRef,
          userKey,
          { branchMode: 'explicit' }
        );
        setUrlAnnotationRepo(repoRef);
      },
      {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userKey: AUTH_USER_KEY,
      }
    );
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });
    await section.getByRole('button', {
      name: 'GitHub sync…',
      exact: true,
    }).click();
    modal = page.getByRole('dialog', {
      name: 'GitHub sync',
      exact: true,
    });
    await modal.getByRole('button', {
      name: 'Pull latest',
      exact: true,
    }).click();
    await expect(modal.getByRole('status')).toHaveText(
      'Pulled latest annotations.',
      { timeout: 10_000 }
    );
    const recovered = await page.evaluate(
      async ({ datasetId, repoRef, userId }) => {
        const { getCommunityAnnotationFileCache } = await import(
          '/assets/js/app/community-annotations/file-cache.js'
        );
        const cached =
          await getCommunityAnnotationFileCache().getAllJsonForRepo({
            datasetId,
            repoRef,
            userId,
            prefixes: ['annotations/moderation/'],
          });
        return Object.keys(cached);
      },
      {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
      }
    );
    expect(recovered).toEqual([
      'annotations/moderation/merges.json',
    ]);
    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    expect(productErrors).toEqual([]);
  },
);

test(
  'corrupt candidate cache preserves the connected repo and a same-modal retry completes the switch',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installGitHubApi(page, async fullName => ({
      body: repoInfo(fullName, { author: true }),
    }));
    await page.route(
      `${WORKER_ORIGIN}/auth/installations`,
      async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            installations: [
              { id: 92, account: { login: 'team' } },
            ],
          }),
        });
      },
    );
    await page.route(
      `${WORKER_ORIGIN}/auth/installation-repos`,
      async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            repositories: [
              { id: 9201, full_name: FIRST_REPO, private: false },
              { id: 9202, full_name: SECOND_REPO, private: false },
            ],
          }),
        });
      },
    );
    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });

    const candidateIndexKey = await page.evaluate(
      async ({ datasetId, repoRef, userId }) => {
        const {
          toFileRecordKey,
          toFileShaIndexKey,
        } = await import(
          '/assets/js/app/community-annotations/cache-scope.js'
        );
        const { getCommunityAnnotationFileCache } = await import(
          '/assets/js/app/community-annotations/file-cache.js'
        );
        const scope = { datasetId, repoRef, userId };
        const path = 'annotations/moderation/merges.json';
        await getCommunityAnnotationFileCache().setJson({
          ...scope,
          path,
          sha: 'f'.repeat(40),
          json: {
            version: 1,
            updatedAt: '2026-07-29T00:00:00.000Z',
            merges: [],
          },
        });
        const recordKey = toFileRecordKey(scope, path);
        await new Promise((resolve, reject) => {
          const open = indexedDB.open(
            'cellucid_community_annotation_file_cache',
            1
          );
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(['files'], 'readwrite');
            tx.objectStore('files').delete(recordKey);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(
              tx.error ??
                new Error('Synthetic candidate cache deletion aborted')
            );
          };
        });
        return toFileShaIndexKey(scope);
      },
      {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${SECOND_REPO}@main`,
        userId: AUTH_USER.id,
      }
    );

    const section = page.locator('#community-annotation-section');
    if (!(await section.evaluate(element => element.open))) {
      await section.locator(':scope > summary').click();
    }
    await section.getByRole('button', {
      name: 'GitHub sync…',
      exact: true,
    }).click();
    const modal = page.getByRole('dialog', {
      name: 'GitHub sync',
      exact: true,
    });
    const status = modal.locator(
      '.community-annotation-wizard-status'
    );
    await modal.getByRole('button', {
      name: 'Back',
      exact: true,
    }).click();
    await expect.poll(() => runtimeSnapshot(page)).toMatchObject({
      currentRepo: `${FIRST_REPO}@main`,
      session: {
        repoRef: `${FIRST_REPO}@main`,
      },
    });
    const candidateCard = modal
      .locator('.community-annotation-repo-grid')
      .nth(1)
      .locator('.community-annotation-repo-card')
      .filter({ hasText: SECOND_REPO });
    await expect(candidateCard).toBeVisible();
    await candidateCard.click();
    const switchRepo = modal.getByRole('button', {
      name: 'Switch repo',
      exact: true,
    });
    await switchRepo.click();
    await expect(status).toContainText(
      /existing repository connection was preserved/i,
      { timeout: 10_000 },
    );
    const candidateFailure = {
      errors: await page.locator('.notification-error').allTextContents(),
      modalCount: await modal.count(),
      runtime: await runtimeSnapshot(page),
      status: await status.allTextContents(),
    };
    expect(candidateFailure).toMatchObject({
      errors: [
        expect.stringMatching(/candidate repository cache was cleared/i),
      ],
      modalCount: 1,
      runtime: {
        role: 'author',
        currentRepo: `${FIRST_REPO}@main`,
        annotationParam: `${FIRST_REPO}@main`,
        session: {
          repoRef: `${FIRST_REPO}@main`,
          userId: AUTH_USER.id,
        },
      },
      status: [
        expect.stringMatching(
          /existing repository connection was preserved/i
        ),
      ],
    });
    expect(
      await page.evaluate(
        key => localStorage.getItem(key),
        candidateIndexKey
      )
    ).toBeNull();

    await switchRepo.click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentRepo: `${SECOND_REPO}@main`,
      annotationParam: `${SECOND_REPO}@main`,
      session: {
        repoRef: `${SECOND_REPO}@main`,
        userId: AUTH_USER.id,
      },
    });
    expect(productErrors).toEqual([]);
  },
);

test(
  'auto-pull survives setup close and retires synchronously across offline and sign-out UI',
  async ({ page, context }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installAutoPullTimerProbe(page, {
      [`${FIRST_DATASET_ID}|team%2Flabels|main|${AUTH_USER.id}`]: {
        enabled: true,
        intervalMs: 600_000,
      },
    });
    await installGitHubApi(page, async fullName => ({
      body: repoInfo(fullName, { author: true }),
    }));

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 1,
      activeDelays: [600_000],
    });

    const section = page.locator('#community-annotation-section');
    if (!(await section.evaluate(element => element.open))) {
      await section.locator(':scope > summary').click();
    }
    const beforeSetupClose = await autoPullTimerSnapshot(page);
    await section.getByRole('button', {
      name: 'GitHub sync…',
      exact: true,
    }).click();
    const modal = page.getByRole('dialog', {
      name: 'GitHub sync',
      exact: true,
    });
    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    await expect(modal).toHaveCount(0);
    expect(await autoPullTimerSnapshot(page)).toEqual(
      beforeSetupClose
    );

    await context.setOffline(true);
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 0,
    });
    const syncButton = section.getByRole('button', {
      name: 'GitHub sync…',
      exact: true,
    });
    await expect(syncButton).toBeDisabled();
    await expect(section).toContainText(
      'Offline: GitHub actions are disabled.'
    );

    await context.setOffline(false);
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 1,
      activeDelays: [600_000],
    });
    await expect(syncButton).toBeEnabled();

    await page.evaluate(async () => {
      const { getGitHubAuthSession } = await import(
        '/assets/js/app/community-annotations/github-auth.js'
      );
      getGitHubAuthSession().signOut();
    });
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 0,
    });
    await expect.poll(() => runtimeSnapshot(page)).toMatchObject({
      authenticated: false,
      currentRepo: null,
      session: {
        repoRef: null,
        userId: null,
      },
    });

    await context.setOffline(true);
    const connectRepo = section.getByRole('button', {
      name: 'Connect repo',
      exact: true,
    });
    await expect(connectRepo).toBeDisabled();
    await expect(section).toContainText(
      'Offline: GitHub actions are disabled.'
    );
    await context.setOffline(false);
    await expect(connectRepo).toBeEnabled();
    expect(productErrors).toEqual([]);
  },
);

test(
  'auto-pull storage and timer failures restore one coherent durable runtime and UI state',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    const scopeKey =
      `${FIRST_DATASET_ID}|team%2Flabels|main|${AUTH_USER.id}`;
    await installStoredAuthentication(page);
    await installAutoPullTimerProbe(page, {
      [scopeKey]: {
        enabled: true,
        intervalMs: 600_000,
      },
    });
    await installGitHubApi(page, async fullName => ({
      body: repoInfo(fullName, { author: true }),
    }));

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 1,
      activeDelays: [600_000],
    });

    const section = page.locator('#community-annotation-section');
    if (!(await section.evaluate(element => element.open))) {
      await section.locator(':scope > summary').click();
    }
    await section.getByRole('button', {
      name: 'GitHub sync…',
      exact: true,
    }).click();
    const modal = page.getByRole('dialog', {
      name: 'GitHub sync',
      exact: true,
    });
    const status = modal.locator(
      '.community-annotation-wizard-status'
    );
    const checkbox = modal.getByRole('checkbox', {
      name: 'Auto pull',
      exact: true,
    });
    const interval = modal.getByRole('combobox', {
      name: 'Auto pull interval',
      exact: true,
    });
    await expect(checkbox).toBeChecked();
    await expect(interval).toHaveValue('600000');
    const baseline = await autoPullTimerSnapshot(page);

    await page.evaluate(() => {
      window.__cellucidAutoPullTimerProbe
        .failNextTrackedCreate = true;
    });
    await interval.selectOption('900000');
    await expect(status).toContainText(
      'Synthetic auto-pull interval creation failure'
    );
    await expect(checkbox).toBeChecked();
    await expect(interval).toHaveValue('600000');
    expect(await autoPullTimerSnapshot(page)).toEqual(baseline);
    expect(
      await page.evaluate(key => JSON.parse(
        localStorage.getItem(
          'cellucid:community-annotations:auto-pull:v1'
        )
      )[key], scopeKey)
    ).toEqual({
      enabled: true,
      intervalMs: 600_000,
    });

    await page.evaluate(() => {
      window.__cellucidAutoPullTimerProbe
        .failNextPreferenceWrite = true;
    });
    await checkbox.click();
    await expect(status).toContainText(
      'Synthetic auto-pull preference storage failure'
    );
    await expect(checkbox).toBeChecked();
    await expect(interval).toHaveValue('600000');
    expect(await autoPullTimerSnapshot(page)).toEqual(baseline);
    expect(
      await page.evaluate(key => JSON.parse(
        localStorage.getItem(
          'cellucid:community-annotations:auto-pull:v1'
        )
      )[key], scopeKey)
    ).toEqual({
      enabled: true,
      intervalMs: 600_000,
    });

    await interval.selectOption('900000');
    await expect(status).toHaveText('');
    await expect(checkbox).toBeChecked();
    await expect(interval).toHaveValue('900000');
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 1,
      activeDelays: [900_000],
      clears: baseline.clears + 1,
      creates: baseline.creates + 1,
    });
    expect(
      await page.evaluate(key => JSON.parse(
        localStorage.getItem(
          'cellucid:community-annotations:auto-pull:v1'
        )
      )[key], scopeKey)
    ).toEqual({
      enabled: true,
      intervalMs: 900_000,
    });
    await modal.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    expect(productErrors).toEqual([]);
  },
);

test(
  'auto-pull owner retires on exact dataset context change and controls destroy',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installAutoPullTimerProbe(page);
    await page.goto(
      '/tests/browser/fixtures/community-annotation-harness.html',
      { waitUntil: 'domcontentloaded' }
    );
    await expect.poll(() => page.evaluate(async () => {
      const { getGitHubAuthSession } = await import(
        '/assets/js/app/community-annotations/github-auth.js'
      );
      return getGitHubAuthSession().isAuthenticated();
    })).toBe(true);
    await expect(page.locator('#harness')).toBeAttached();
    expect(await autoPullTimerSnapshot(page)).toMatchObject({
      active: 0,
    });

    await page.evaluate(async ({ repoRef, userId, userKey }) => {
      const [
        { initCommunityAnnotationControls },
        { setAnnotationRepoForDataset },
      ] = await Promise.all([
        import(
          '/assets/js/app/ui/modules/community-annotation-controls.js'
        ),
        import('/assets/js/app/community-annotations/repo-store.js'),
      ]);
      const firstDataset = 'synthetic-auto-pull-a';
      const secondDataset = 'synthetic-auto-pull-b';
      setAnnotationRepoForDataset(
        firstDataset,
        repoRef,
        userKey,
        { branchMode: 'explicit' }
      );
      const scope =
        `${encodeURIComponent(firstDataset)}|` +
        `${encodeURIComponent(repoRef.split('@')[0])}|` +
        `${encodeURIComponent(repoRef.split('@')[1])}|` +
        `${encodeURIComponent(String(userId))}`;
      localStorage.setItem(
        'cellucid:community-annotations:auto-pull:v1',
        JSON.stringify({
          [scope]: {
            enabled: true,
            intervalMs: 600_000,
          },
        })
      );

      const listeners = new Set();
      const dataSourceManager = {
        currentDatasetId: firstDataset,
        getCurrentDatasetId() {
          return this.currentDatasetId;
        },
        onDatasetChange(listener) {
          listeners.add(listener);
        },
        offDatasetChange(listener) {
          listeners.delete(listener);
        },
      };
      const container = document.createElement('div');
      container.id = 'synthetic-auto-pull-controls';
      document.body.appendChild(container);
      const controls = initCommunityAnnotationControls({
        state: {
          getFields() {
            return [];
          },
        },
        dom: { container },
        dataSourceManager,
        infoPopovers: {
          closeWithin() {},
          configurePair(button, tooltip, { id, label }) {
            button.type = 'button';
            button.setAttribute('aria-controls', id);
            button.setAttribute('aria-label', label);
            button.setAttribute('aria-expanded', 'false');
            tooltip.id = id;
            tooltip.hidden = true;
          },
        },
      });
      window.__cellucidSyntheticAutoPull = {
        container,
        controls,
        dataSourceManager,
        firstDataset,
        secondDataset,
        listeners,
      };
    }, {
      repoRef: `${FIRST_REPO}@main`,
      userId: AUTH_USER.id,
      userKey: AUTH_USER_KEY,
    });
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 1,
      activeDelays: [600_000],
    });

    await page.evaluate(() => {
      const owner = window.__cellucidSyntheticAutoPull;
      owner.dataSourceManager.currentDatasetId = owner.secondDataset;
      for (const listener of [...owner.listeners]) listener();
    });
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 0,
    });

    await page.evaluate(() => {
      const owner = window.__cellucidSyntheticAutoPull;
      owner.dataSourceManager.currentDatasetId = owner.firstDataset;
      for (const listener of [...owner.listeners]) listener();
    });
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 1,
      activeDelays: [600_000],
    });

    const destroyResult = await page.evaluate(() => {
      const owner = window.__cellucidSyntheticAutoPull;
      owner.controls.destroy();
      const result = {
        listenersRemaining: owner.listeners.size,
      };
      owner.container.remove();
      delete window.__cellucidSyntheticAutoPull;
      return result;
    });
    expect(destroyResult).toEqual({ listenersRemaining: 0 });
    await expect.poll(() => autoPullTimerSnapshot(page)).toMatchObject({
      active: 0,
    });
    expect(productErrors).toEqual([]);
  },
);

test(
  'a retry whose timer fires during active sync resumes after sync settlement',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    const activePullEntered = deferred();
    const releaseActivePull = deferred();
    let repoRequestCount = 0;
    let retryDueAt = 0;
    await installGitHubApi(page, async fullName => {
      repoRequestCount += 1;
      if (repoRequestCount === 1) {
        retryDueAt = Date.now() + 5_000;
        return {
          status: 503,
          headers: { 'retry-after': '5' },
          body: { error: 'synthetic retry before active pull' },
        };
      }
      if (repoRequestCount === 2) {
        activePullEntered.resolve();
        await releaseActivePull.promise;
      }
      return {
        body: repoInfo(fullName, { author: true }),
      };
    });

    await openPreparedDeepLink(page);
    await expect(page.locator('.notification-warning').last()).toContainText(
      'repository connection was preserved',
    );
    await page.evaluate(() => {
      const section = document.querySelector(
        '#community-annotation-section',
      );
      if (!(section instanceof HTMLDetailsElement)) {
        throw new Error('Community annotation section is unavailable');
      }
      section.open = true;
      const openSync = [...section.querySelectorAll('button')].find(
        button => button.textContent === 'GitHub sync…',
      );
      if (!(openSync instanceof HTMLButtonElement)) {
        throw new Error('GitHub sync button is unavailable');
      }
      openSync.click();
      const pullLatest = [
        ...document.querySelectorAll(
          '.community-annotation-modal-overlay button',
        ),
      ].find(button => button.textContent === 'Pull latest');
      if (!(pullLatest instanceof HTMLButtonElement)) {
        throw new Error('Pull latest button is unavailable');
      }
      pullLatest.click();
    });
    await activePullEntered.promise;
    expect(repoRequestCount).toBe(2);

    // The owner retry is due while the explicit pull owns syncBusy. It must be
    // queued, not consumed into a null-timer state.
    await page.waitForTimeout(
      Math.max(0, retryDueAt + 400 - Date.now()),
    );
    expect(repoRequestCount).toBe(2);
    await page.evaluate(async () => {
      const { getCommunityAnnotationAccessStore } = await import(
        '/assets/js/app/community-annotations/access-store.js'
      );
      const access = getCommunityAnnotationAccessStore();
      const originalSetRoleFromRepoInfo = access.setRoleFromRepoInfo;
      const originalGetRole = access.getRole;
      window.__cellucidBusyRoleRetryProbe = {
        suppressedRoleWrites: 0,
        syntheticRoleReads: 0,
      };
      access.setRoleFromRepoInfo = function suppressOneRoleWrite() {
        window.__cellucidBusyRoleRetryProbe.suppressedRoleWrites += 1;
        access.setRoleFromRepoInfo = originalSetRoleFromRepoInfo;
      };
      access.getRole = function synthesizeOneSettledRoleRead() {
        window.__cellucidBusyRoleRetryProbe.syntheticRoleReads += 1;
        access.getRole = originalGetRole;
        return 'annotator';
      };
    });
    releaseActivePull.resolve();

    await expect.poll(() => repoRequestCount, { timeout: 10_000 }).toBe(3);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
      },
    });
    const probe = await page.evaluate(
      () => window.__cellucidBusyRoleRetryProbe,
    );
    expect(probe).toEqual({
      suppressedRoleWrites: 1,
      syntheticRoleReads: 1,
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(withoutExpectedServiceUnavailableConsole(productErrors)).toEqual([]);
  },
);

test(
  'online intent queued during role settlement retries once after that settlement',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    const firstRequestEntered = deferred();
    const releaseFirstRequest = deferred();
    let repoRequestCount = 0;
    await installGitHubApi(page, async fullName => {
      repoRequestCount++;
      if (repoRequestCount === 1) {
        firstRequestEntered.resolve();
        await releaseFirstRequest.promise;
        return {
          status: 503,
          body: { error: 'synthetic request became stale while offline' },
        };
      }
      return {
        body: repoInfo(fullName, { author: true }),
      };
    });

    await openPreparedDeepLink(page);
    await firstRequestEntered.promise;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await settleBrowserContinuations(page);
    releaseFirstRequest.resolve();

    await expect.poll(() => repoRequestCount, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'author',
      cacheMode: 'indexeddb',
      currentRepo: `${FIRST_REPO}@main`,
      annotationParam: `${FIRST_REPO}@main`,
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
      },
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(withoutExpectedServiceUnavailableConsole(productErrors)).toEqual([]);
  },
);

test(
  'stale dataset and repository role settlement cannot overwrite the latest scope',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installAlternatePreparedDataset(page);
    const releaseFirstRepo = deferred();
    const requestedRepos = [];
    await installGitHubApi(page, async fullName => {
      requestedRepos.push(fullName);
      if (fullName === FIRST_REPO) {
        await releaseFirstRepo.promise;
        return {
          body: repoInfo(fullName, { author: false }),
        };
      }
      if (fullName === SECOND_REPO) {
        return {
          body: repoInfo(fullName, { author: true }),
        };
      }
      throw new Error(`Unexpected repository request: ${fullName}`);
    });

    await openPreparedDeepLink(page);
    await expect.poll(
      () => requestedRepos,
      { timeout: 10_000 },
    ).toContain(FIRST_REPO);
    const staleRepoRequestFailed =
      waitForRepoRequestFailure(page, FIRST_REPO);
    await page.evaluate(async repo => {
      const { setUrlAnnotationRepo } =
        await import('/assets/js/app/url-state.js');
      setUrlAnnotationRepo(`${repo}@main`);
    }, SECOND_REPO);
    await page.locator('#dataset-select').selectOption(
      SECOND_DATASET_OPTION,
    );
    await expect(page.locator('#dataset-name')).toHaveText(
      SECOND_DATASET_NAME,
    );
    releaseFirstRepo.resolve();
    await staleRepoRequestFailed;
    await settleBrowserContinuations(page);

    await expect.poll(
      () => requestedRepos,
      { timeout: 10_000 },
    ).toContain(SECOND_REPO);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentDatasetId: SECOND_DATASET_ID,
      currentRepo: `${SECOND_REPO}@main`,
      annotationParam: `${SECOND_REPO}@main`,
      session: {
        datasetId: SECOND_DATASET_ID,
        repoRef: `${SECOND_REPO}@main`,
        userId: AUTH_USER.id,
        profile: {
          username: AUTH_USER_KEY,
          githubUserId: AUTH_USER.id,
        },
      },
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'dirty consensus settings drafts never cross an exact dataset context boundary',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installAlternatePreparedDataset(page);
    await installGitHubApi(page, async fullName => ({
      body: repoInfo(fullName, { author: true }),
    }));

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentDatasetId: FIRST_DATASET_ID,
      currentRepo: `${FIRST_REPO}@main`,
    });
    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      const session = getCommunityAnnotationSession();
      session.setFieldAnnotated('cell_type', true);
      session.setAnnotatableConsensusSettings('cell_type', {
        minAnnotators: 1,
        threshold: 0.5,
      });
    });

    const section = page.locator('#community-annotation-section');
    if (!(await section.evaluate(element => element.open))) {
      await section.locator('summary').click();
    }
    const manageHeader = section.locator(
      '.analysis-accordion-header',
      { hasText: 'MANAGE ANNOTATION' },
    );
    if ((await manageHeader.getAttribute('aria-expanded')) !== 'true') {
      await manageHeader.click();
    }
    let settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await expect(settings).toBeVisible();
    await expect(settings.locator('input[type="range"]')).toHaveValue('50');

    await settings.locator('input[type="range"]').evaluate(input => {
      input.value = '80';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await expect(settings.locator('input[type="range"]')).toHaveValue('80');
    await expect(
      settings.getByRole('button', { name: 'Apply', exact: true }),
    ).toBeEnabled();

    await page.evaluate(async repo => {
      const { setUrlAnnotationRepo } =
        await import('/assets/js/app/url-state.js');
      setUrlAnnotationRepo(`${repo}@main`);
    }, SECOND_REPO);
    await page.locator('#dataset-select').selectOption(
      SECOND_DATASET_OPTION,
    );
    await expect(page.locator('#dataset-name')).toHaveText(
      SECOND_DATASET_NAME,
    );
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentDatasetId: SECOND_DATASET_ID,
      currentRepo: `${SECOND_REPO}@main`,
      session: {
        datasetId: SECOND_DATASET_ID,
        repoRef: `${SECOND_REPO}@main`,
      },
    });
    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      const session = getCommunityAnnotationSession();
      session.setFieldAnnotated('cell_type', true);
      session.setAnnotatableConsensusSettings('cell_type', {
        minAnnotators: 1,
        threshold: 0.25,
      });
    });

    if (!(await section.evaluate(element => element.open))) {
      await section.locator('summary').click();
    }
    if ((await manageHeader.getAttribute('aria-expanded')) !== 'true') {
      await manageHeader.click();
    }
    settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await expect(settings).toBeVisible();
    await expect(settings.locator('input[type="range"]')).toHaveValue('25');
    await expect(
      settings.getByRole('button', { name: 'Apply', exact: true }),
    ).toBeDisabled();
    const secondDatasetSettings = await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      return getCommunityAnnotationSession()
        .getAnnotatableConsensusSettings('cell_type');
    });
    expect(secondDatasetSettings).toEqual({
      minAnnotators: 1,
      threshold: 0.25,
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'prototype-named categorical fields complete the author settings lifecycle',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    const prototypeSettings = Object.fromEntries([
      ['__proto__', { minAnnotators: 1, threshold: 0.5 }],
    ]);
    const prototypeConfig = {
      version: 1,
      supportedDatasets: [
        {
          datasetId: FIRST_DATASET_ID,
          name: 'Current UI prepared fixture',
          fieldsToAnnotate: ['__proto__'],
          annotatableSettings: prototypeSettings,
          closedFields: [],
        },
      ],
    };
    await installStoredAuthentication(page);
    await installPrototypeNamedPreparedField(page);
    await installGitHubApi(
      page,
      async fullName => ({
        body: repoInfo(fullName, { author: true }),
      }),
      {
        resolveContentFile: async path => (
          path === 'annotations/config.json'
            ? {
                text: JSON.stringify(prototypeConfig),
                sha: 'd'.repeat(40),
              }
            : undefined
        ),
      },
    );

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentDatasetId: FIRST_DATASET_ID,
      currentRepo: `${FIRST_REPO}@main`,
    });
    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      const session = getCommunityAnnotationSession();
      session.setFieldAnnotated('__proto__', true);
      session.setAnnotatableConsensusSettings('__proto__', {
        minAnnotators: 1,
        threshold: 0.5,
      });
    });

    const section = page.locator('#community-annotation-section');
    if (!(await section.evaluate(element => element.open))) {
      await section.locator('summary').click();
    }
    const manageHeader = section.locator(
      '.analysis-accordion-header',
      { hasText: 'MANAGE ANNOTATION' },
    );
    if ((await manageHeader.getAttribute('aria-expanded')) !== 'true') {
      await manageHeader.click();
    }
    await expect(
      section.getByRole('combobox', { name: 'Categorical obs' }),
    ).toHaveValue('__proto__');

    let settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await expect(settings).toBeVisible();
    await expect(settings.locator('input[type="range"]')).toHaveValue('50');
    await expect(settings.locator('input[type="number"]')).toHaveValue('1');

    await settings.locator('input[type="range"]').evaluate(input => {
      input.value = '80';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await settings.locator('input[type="number"]').fill('3');
    await settings.locator('input[type="number"]').press('Tab');
    settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await settings.getByRole('button', {
      name: 'Reset',
      exact: true,
    }).click();
    settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await expect(settings.locator('input[type="range"]')).toHaveValue('50');
    await expect(settings.locator('input[type="number"]')).toHaveValue('1');

    await settings.locator('input[type="range"]').evaluate(input => {
      input.value = '80';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await settings.locator('input[type="number"]').fill('3');
    await settings.locator('input[type="number"]').press('Tab');
    settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await settings.getByRole('button', {
      name: 'Apply',
      exact: true,
    }).click();

    const applied = await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      const session = getCommunityAnnotationSession();
      const map = session.getAnnotatableConsensusSettingsMap();
      return {
        hasOwn: Object.hasOwn(map, '__proto__'),
        keys: Object.keys(map),
        setting: session.getAnnotatableConsensusSettings('__proto__'),
      };
    });
    expect(applied).toEqual({
      hasOwn: true,
      keys: ['__proto__'],
      setting: { minAnnotators: 3, threshold: 0.8 },
    });

    const manageActions = section.locator(
      '.community-annotation-consensus-actions' +
      '[aria-label="Manage annotation actions"]',
    );
    await manageActions.getByRole('button', {
      name: 'Close',
      exact: true,
    }).click();
    await expect(manageActions.getByRole('button', {
      name: 'Reopen',
      exact: true,
    })).toBeVisible();
    await manageActions.getByRole('button', {
      name: 'Reopen',
      exact: true,
    }).click();
    await manageActions.getByRole('button', {
      name: 'Remove',
      exact: true,
    }).click();
    await expect(
      section.locator('.community-annotation-settings.relative'),
    ).toHaveCount(0);
    await manageActions.getByRole('button', {
      name: 'Add',
      exact: true,
    }).click();
    settings = section.locator(
      '.community-annotation-settings.relative',
    );
    await expect(settings).toBeVisible();
    await expect(settings.locator('input[type="range"]')).toHaveValue('50');
    await expect(settings.locator('input[type="number"]')).toHaveValue('1');

    const finalState = await page.evaluate(async () => {
      const { getCommunityAnnotationSession } = await import(
        '/assets/js/app/community-annotations/session.js'
      );
      const session = getCommunityAnnotationSession();
      return {
        annotated: session.isFieldAnnotated('__proto__'),
        closed: session.isFieldClosed('__proto__'),
        setting: session.getAnnotatableConsensusSettings('__proto__'),
      };
    });
    expect(finalState).toEqual({
      annotated: true,
      closed: false,
      setting: { minAnnotators: 1, threshold: 0.5 },
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'stale role settlement cannot resurrect a signed-out user scope',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    const releaseRepo = deferred();
    let repoRequested = false;
    await installGitHubApi(page, async fullName => {
      repoRequested = true;
      await releaseRepo.promise;
      return {
        body: repoInfo(fullName, { author: true }),
      };
    });

    await openPreparedDeepLink(page);
    await expect.poll(
      () => repoRequested,
      { timeout: 10_000 },
    ).toBe(true);
    const staleRepoRequestFailed =
      waitForRepoRequestFailure(page, FIRST_REPO);
    await page.evaluate(async () => {
      const { getGitHubAuthSession } =
        await import('/assets/js/app/community-annotations/github-auth.js');
      getGitHubAuthSession().signOut();
    });
    releaseRepo.resolve();
    await staleRepoRequestFailed;
    await settleBrowserContinuations(page);

    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: false,
      role: 'unknown',
      currentDatasetId: FIRST_DATASET_ID,
      currentRepo: null,
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: null,
        userId: null,
        profile: {
          username: 'local',
          login: '',
          githubUserId: null,
        },
      },
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'a dispatched publication keeps its unknown outcome across sign-out context abort',
  async ({ page }) => {
    await installStoredAuthentication(page);
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    const mutationSettled = deferred();
    const mutationRequests = [];
    let mutationRouteSettlementError = null;
    await installGitHubApi(
      page,
      async fullName => ({
        body: repoInfo(fullName, { author: false }),
      }),
      {
        userFileExists: false,
        handleMutation: async ({ method, request, route, url }) => {
          const requestHeaders = await request.allHeaders();
          mutationRequests.push({
            method,
            operationId: requestHeaders[OPERATION_ID_HEADER] ?? null,
            path: url.pathname,
          });
          mutationEntered.resolve();
          await releaseMutation.promise;
          try {
            await route.abort('failed');
          } catch (error) {
            if (request.failure() === null) {
              mutationRouteSettlementError = error;
            }
          } finally {
            mutationSettled.resolve();
          }
        },
      },
    );

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'annotator',
      currentRepo: `${FIRST_REPO}@main`,
    });

    await startGitHubPublication(page);
    await mutationEntered.promise;
    expect(mutationRequests).toHaveLength(1);
    expect(mutationRequests[0]).toMatchObject({
      method: 'PUT',
      path:
        `/api/repos/${FIRST_REPO}/contents/annotations/users/` +
        `${AUTH_USER_KEY}.json`,
    });
    expect(mutationRequests[0].operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await page.evaluate(async () => {
      const { getGitHubAuthSession } =
        await import('/assets/js/app/community-annotations/github-auth.js');
      getGitHubAuthSession().signOut();
    });
    releaseMutation.resolve();
    await mutationSettled.promise;
    if (mutationRouteSettlementError !== null) {
      throw mutationRouteSettlementError;
    }

    const terminalError = page.locator('.notification-error').last();
    await expect(terminalError).toBeVisible({ timeout: 10_000 });
    await expect(terminalError).toContainText(
      UNKNOWN_PUBLICATION_GUIDANCE,
    );
    expect(
      await page.locator('.notification-success').allTextContents(),
    ).not.toContain('Cancelled.');
    expect(mutationRequests).toHaveLength(1);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: false,
      role: 'unknown',
      currentRepo: null,
    });
  },
);

test(
  'a pre-mutation publication abort remains an inert owned cancellation',
  async ({ page }) => {
    await installStoredAuthentication(page);
    const publicationRepoEntered = deferred();
    const releasePublicationRepo = deferred();
    let gatePublicationRepo = false;
    let mutationCount = 0;
    await installGitHubApi(
      page,
      async fullName => {
        if (gatePublicationRepo) {
          publicationRepoEntered.resolve();
          await releasePublicationRepo.promise;
        }
        return {
          body: repoInfo(fullName, { author: false }),
        };
      },
      {
        handleMutation: async ({ request, route }) => {
          mutationCount += 1;
          const requestHeaders = await request.allHeaders();
          const operationId =
            requestHeaders[OPERATION_ID_HEADER] ?? '';
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            headers: {
              'access-control-expose-headers':
                'X-Cellucid-Operation-Id, X-Cellucid-Operation-Outcome',
              'x-cellucid-operation-id': operationId,
              'x-cellucid-operation-outcome': 'not-applied',
            },
            body: JSON.stringify({
              error: 'unexpected mutation after pre-dispatch cancellation',
            }),
          });
        },
      },
    );

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'annotator',
      currentRepo: `${FIRST_REPO}@main`,
    });

    gatePublicationRepo = true;
    await startGitHubPublication(page);
    await publicationRepoEntered.promise;
    const repoRequestFailed = waitForRepoRequestFailure(page, FIRST_REPO);
    await page.evaluate(async () => {
      const { getGitHubAuthSession } =
        await import('/assets/js/app/community-annotations/github-auth.js');
      getGitHubAuthSession().signOut();
    });
    releasePublicationRepo.resolve();
    await repoRequestFailed;

    const terminalError = page.locator('.notification-error').last();
    await expect(terminalError).toBeVisible({ timeout: 10_000 });
    await expect(terminalError).toContainText(
      'Annotation dataset, repository, or authenticated user changed.',
    );
    await expect(terminalError).not.toContainText(
      UNKNOWN_PUBLICATION_GUIDANCE,
    );
    expect(mutationCount).toBe(0);
  },
);

test(
  'an exact-byte no-op publication seeds the SHA baseline for the next edit',
  async ({ page }) => {
    const userPath = `annotations/users/${AUTH_USER_KEY}.json`;
    const firstRemoteSha = 'a'.repeat(40);
    const secondRemoteSha = 'b'.repeat(40);
    let exactRemoteText = null;
    const mutationRequests = [];

    await installStoredAuthentication(page);
    await installGitHubApi(
      page,
      async fullName => ({
        body: repoInfo(fullName, { author: false }),
      }),
      {
        userFileExists: false,
        resolveUserFile: async () => (
          exactRemoteText === null
            ? null
            : { text: exactRemoteText, sha: firstRemoteSha }
        ),
        handleMutation: async ({ method, request, route, url }) => {
          const requestHeaders = await request.allHeaders();
          const operationId =
            requestHeaders[OPERATION_ID_HEADER] ?? null;
          mutationRequests.push({
            body: JSON.parse(request.postData() ?? 'null'),
            method,
            operationId,
            path: url.pathname,
          });
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: {
              'access-control-expose-headers':
                'X-Cellucid-Operation-Id, X-Cellucid-Operation-Outcome',
              'x-cellucid-operation-id': operationId ?? '',
              'x-cellucid-operation-outcome': 'applied',
            },
            body: JSON.stringify({
              content: { sha: secondRemoteSha },
            }),
          });
        },
      },
    );

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'annotator',
      currentRepo: `${FIRST_REPO}@main`,
    });

    const exactDocument = await page.evaluate(
      async ({ login, userId, userKey }) => {
        const { getCommunityAnnotationSession } =
          await import('/assets/js/app/community-annotations/session.js');
        const session = getCommunityAnnotationSession();
        session.setProfile({
          username: userKey,
          login,
          githubUserId: userId,
          displayName: 'Publication Lifecycle Tester',
          title: '',
          orcid: '',
          linkedin: '',
        });
        const document = session.buildUserFileDocument({
          githubUserId: userId,
        });
        session.buildUserFileDocument = () =>
          JSON.parse(JSON.stringify(document));
        return document;
      },
      {
        login: AUTH_USER.login,
        userId: AUTH_USER.id,
        userKey: AUTH_USER_KEY,
      },
    );
    exactRemoteText = `${JSON.stringify(exactDocument, null, 2)}\n`;

    const { modal, publish } = await startGitHubPublication(page);
    const status = modal.getByRole('status');
    await expect(status).toHaveText('Publish complete.', {
      timeout: 10_000,
    });
    expect(mutationRequests).toHaveLength(0);
    const baselineAfterNoOp = await page.evaluate(async path => {
      const { getCommunityAnnotationSession } =
        await import('/assets/js/app/community-annotations/session.js');
      return getCommunityAnnotationSession().getRemoteFileShas()[path] ?? null;
    }, userPath);

    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } =
        await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      delete session.buildUserFileDocument;
      session.setProfile({
        ...session.getProfile(),
        title: 'Edited after exact-byte retry',
      });
    });
    await expect(publish).toBeEnabled();
    await publish.click();
    let secondOutcome = 'pending';
    await expect.poll(async () => {
      const statusText = await status.textContent();
      secondOutcome = mutationRequests.length === 1
        ? 'mutation-dispatched'
        : (
          /Missing baseline version/.test(statusText ?? '')
            ? 'missing-baseline-conflict'
            : 'pending'
        );
      return secondOutcome;
    }, { timeout: 10_000 }).not.toBe('pending');

    expect(
      baselineAfterNoOp,
      `second publication outcome: ${secondOutcome}`,
    ).toBe(firstRemoteSha);
    expect(mutationRequests).toHaveLength(1);
    await expect(status).toHaveText('Publish complete.', {
      timeout: 10_000,
    });

    expect(mutationRequests[0]).toMatchObject({
      method: 'PUT',
      path: `/api/repos/${FIRST_REPO}/contents/${userPath}`,
      body: { sha: firstRemoteSha },
    });
    expect(mutationRequests[0].operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const finalBaseline = await page.evaluate(async path => {
      const { getCommunityAnnotationSession } =
        await import('/assets/js/app/community-annotations/session.js');
      return getCommunityAnnotationSession().getRemoteFileShas()[path] ?? null;
    }, userPath);
    expect(finalBaseline).toBe(secondRemoteSha);
  },
);

for (const target of ['config', 'merges']) {
  test(
    `an exact-byte ${target} no-op seeds the author baseline for its next edit`,
    async ({ page }) => {
      await runExactAuthorBaselineLifecycle(page, target);
    },
  );
}

test(
  'a later author-file failure identifies the already completed publication step',
  async ({ page }) => {
    const userPath = `annotations/users/${AUTH_USER_KEY}.json`;
    const publishedSha = '9'.repeat(40);
    const mutationRequests = [];

    await installStoredAuthentication(page);
    await installGitHubApi(
      page,
      async fullName => ({
        body: repoInfo(fullName, { author: true }),
      }),
      {
        userFileExists: false,
        handleMutation: async ({ method, request, route, url }) => {
          const requestHeaders = await request.allHeaders();
          const operationId =
            requestHeaders[OPERATION_ID_HEADER] ?? '';
          mutationRequests.push({
            method,
            path: url.pathname,
          });
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: {
              'access-control-expose-headers':
                'X-Cellucid-Operation-Id, X-Cellucid-Operation-Outcome',
              'x-cellucid-operation-id': operationId,
              'x-cellucid-operation-outcome': 'applied',
            },
            body: JSON.stringify({
              content: { sha: publishedSha },
            }),
          });
        },
      },
    );

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });
    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } =
        await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      session.setFieldAnnotated('cell_type', true);
      session.setAnnotatableConsensusSettings('cell_type', {
        minAnnotators: 1,
        threshold: 0.5,
      });
    });

    let publicationConfigReads = 0;
    await page.route(
      `${WORKER_ORIGIN}/api/repos/${FIRST_REPO}/contents/` +
        'annotations/config.json**',
      async route => {
        publicationConfigReads += 1;
        if (publicationConfigReads === 1) {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 413,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Synthetic annotation config byte-limit failure',
          }),
        });
      },
    );

    await startGitHubPublication(page);

    const terminalError = page.locator('.notification-error').last();
    await expect(terminalError).toBeVisible({ timeout: 10_000 });
    await expect(terminalError).toContainText(
      'Publication was only partially completed.',
    );
    await expect(terminalError).toContainText(userPath);
    await expect(terminalError).toContainText(
      'The next step, annotations/config.json, did not complete.',
    );
    await expect(terminalError).toContainText(
      'Completed exact bytes are detected as a no-op',
    );
    expect(mutationRequests).toEqual([{
      method: 'PUT',
      path: `/api/repos/${FIRST_REPO}/contents/${userPath}`,
    }]);
    expect(publicationConfigReads).toBe(2);
    const baseline = await page.evaluate(async path => {
      const { getCommunityAnnotationSession } =
        await import('/assets/js/app/community-annotations/session.js');
      return getCommunityAnnotationSession().getRemoteFileShas()[path] ?? null;
    }, userPath);
    expect(baseline).toBe(publishedSha);
  },
);

test(
  'an oversized local author file is rejected before any publication mutation',
  async ({ page }) => {
    let mutationCount = 0;
    await installStoredAuthentication(page);
    await installGitHubApi(
      page,
      async fullName => ({
        body: repoInfo(fullName, { author: true }),
      }),
      {
        handleMutation: async () => {
          mutationCount += 1;
          throw new Error('Unexpected mutation after author-file preflight');
        },
      },
    );

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });
    const mergesBytes = await page.evaluate(async () => {
      const { getCommunityAnnotationSession } =
        await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      session.setFieldAnnotated('cell_type', true);
      session.setAnnotatableConsensusSettings('cell_type', {
        minAnnotators: 1,
        threshold: 0.5,
      });
      const document = {
        version: 1,
        updatedAt: '2026-07-29T00:00:00.000Z',
        merges: Array.from({ length: 1000 }, (_, index) => ({
          bucket: `cell_type:${'x'.repeat(985)}${index}`,
          fromSuggestionId: `from-${index}`,
          intoSuggestionId: `into-${index}`,
          by: 'ghid_4242',
          at: '2026-07-29T00:00:00.000Z',
          note: 'n'.repeat(512),
        })),
      };
      session.buildModerationMergesDocument = () => document;
      return new TextEncoder().encode(
        `${JSON.stringify(document, null, 2)}\n`,
      ).byteLength;
    });
    expect(mergesBytes).toBeGreaterThan(1_000_000);

    await startGitHubPublication(page);

    const terminalError = page.locator('.notification-error').last();
    await expect(terminalError).toBeVisible({ timeout: 10_000 });
    await expect(terminalError).toContainText(
      'annotations/moderation/merges.json is',
    );
    await expect(terminalError).toContainText(
      'GitHub Contents supports at most 1000000 bytes',
    );
    await expect(terminalError).not.toContainText(
      'Publication was only partially completed.',
    );
    expect(mutationCount).toBe(0);
  },
);

test(
  'author config preflight uses the exact merged remote document before any mutation',
  async ({ page }) => {
    const nearLimitConfig =
      configDocumentAtCanonicalBytes(1_000_000);
    const configText =
      `${JSON.stringify(nearLimitConfig, null, 2)}\n`;
    expect(Buffer.byteLength(configText, 'utf8')).toBe(1_000_000);
    let mutationCount = 0;

    await installStoredAuthentication(page);
    await installGitHubApi(
      page,
      async fullName => ({
        body: repoInfo(fullName, { author: true }),
      }),
      {
        handleMutation: async () => {
          mutationCount += 1;
          throw new Error(
            'Unexpected mutation after merged config preflight'
          );
        },
        resolveContentFile: async path => {
          if (path !== 'annotations/config.json') return undefined;
          return {
            text: configText,
            sha: 'd'.repeat(40),
          };
        },
      },
    );

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });
    await page.evaluate(async () => {
      const { getCommunityAnnotationSession } =
        await import('/assets/js/app/community-annotations/session.js');
      const session = getCommunityAnnotationSession();
      session.setFieldAnnotated('cell_type', true);
      session.setAnnotatableConsensusSettings('cell_type', {
        minAnnotators: 1,
        threshold: 0.5,
      });
    });

    await startGitHubPublication(page);

    const terminalError = page.locator('.notification-error').last();
    await expect(terminalError).toBeVisible({ timeout: 10_000 });
    await expect(terminalError).toContainText(
      'annotations/config.json is 1000002 UTF-8 bytes',
    );
    await expect(terminalError).toContainText(
      'GitHub Contents supports at most 1000000 bytes',
    );
    await expect(terminalError).not.toContainText(
      'Publication was only partially completed.',
    );
    expect(mutationCount).toBe(0);
  },
);

test(
  'stale default-branch resolution cannot persist into a newer dataset scope',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installAlternatePreparedDataset(page);
    const releaseDefaultBranch = deferred();
    let firstRepoRequestCount = 0;
    await installGitHubApi(page, async fullName => {
      if (fullName === FIRST_REPO) {
        firstRepoRequestCount++;
        if (firstRepoRequestCount === 1) {
          await releaseDefaultBranch.promise;
        }
        return {
          body: repoInfo(fullName, { author: false }),
        };
      }
      if (fullName === SECOND_REPO) {
        return {
          body: repoInfo(fullName, { author: true }),
        };
      }
      throw new Error(`Unexpected repository request: ${fullName}`);
    });

    await page.goto(deepLink(FIRST_REPO, { includeBranch: false }), {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await expect.poll(
      () => firstRepoRequestCount,
      { timeout: 10_000 },
    ).toBe(1);
    const staleDefaultBranchRequestFailed =
      waitForRepoRequestFailure(page, FIRST_REPO);

    await page.evaluate(async repo => {
      const { setUrlAnnotationRepo } =
        await import('/assets/js/app/url-state.js');
      setUrlAnnotationRepo(`${repo}@main`);
    }, SECOND_REPO);
    await page.locator('#dataset-select').selectOption(
      SECOND_DATASET_OPTION,
    );
    await expect(page.locator('#dataset-name')).toHaveText(
      SECOND_DATASET_NAME,
    );

    releaseDefaultBranch.resolve();
    await staleDefaultBranchRequestFailed;
    await settleBrowserContinuations(page);

    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentDatasetId: SECOND_DATASET_ID,
      currentRepo: `${SECOND_REPO}@main`,
      reposByDataset: {
        first: null,
        second: `${SECOND_REPO}@main`,
      },
      annotationParam: `${SECOND_REPO}@main`,
      session: {
        datasetId: SECOND_DATASET_ID,
        repoRef: `${SECOND_REPO}@main`,
        userId: AUTH_USER.id,
      },
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'sign-out and reconnect restore the exact authenticated cache scope',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installStoredAuthentication(page);
    await installGitHubApi(page, async fullName => ({
      body: repoInfo(fullName, { author: true }),
    }));

    await openPreparedDeepLink(page);
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
    });

    await page.evaluate(async () => {
      const { getGitHubAuthSession } =
        await import('/assets/js/app/community-annotations/github-auth.js');
      getGitHubAuthSession().signOut();
    });
    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: false,
      role: 'unknown',
      currentRepo: null,
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: null,
        userId: null,
        profile: {
          username: 'local',
          githubUserId: null,
        },
      },
    });

    await page.evaluate(async () => {
      const { getGitHubAuthSession } =
        await import('/assets/js/app/community-annotations/github-auth.js');
      const callbackUrl =
        `${window.location.origin}${window.location.pathname}` +
        `${window.location.search}` +
        '#cellucid_github_auth=1&cellucid_github_token=synthetic-token';
      await getGitHubAuthSession().completeSignInFromRedirect({
        url: callbackUrl,
      });
    });

    await expect.poll(() => runtimeSnapshot(page), {
      timeout: 10_000,
    }).toMatchObject({
      authenticated: true,
      role: 'author',
      currentRepo: `${FIRST_REPO}@main`,
      annotationParam: `${FIRST_REPO}@main`,
      session: {
        datasetId: FIRST_DATASET_ID,
        repoRef: `${FIRST_REPO}@main`,
        userId: AUTH_USER.id,
        profile: {
          username: AUTH_USER_KEY,
          login: AUTH_USER.login,
          githubUserId: AUTH_USER.id,
          displayName: 'Reconnect Tester',
        },
      },
    });
    await expect(page.locator('.notification-error')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'OAuth callbacks scrub credentials before validation and authentication',
  async ({ page }) => {
    const pageErrors = [];
    const authUserRequestHashes = [];
    page.on('pageerror', error => {
      pageErrors.push(error.stack || error.message);
    });
    await page.addInitScript(workerOrigin => {
      window.__CELLUCID_GITHUB_WORKER_ORIGIN__ = workerOrigin;
      sessionStorage.removeItem('cellucid:github-app-auth:session');
    }, WORKER_ORIGIN);
    await installWorkerCapability(page);
    await page.route(`${WORKER_ORIGIN}/auth/user`, async route => {
      authUserRequestHashes.push(new URL(page.url()).hash);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(AUTH_USER),
      });
    });

    const retainedBefore =
      'view=umap&duplicate=first&lower=%2f&upper=%2F' +
      '&space=%20&bare&&empty=';
    const retainedAfter =
      'tail=%FF&duplicate=second' +
      '&payload=cellucid_github_token%3Dnot-a-field';
    const cleanedHash = `#${retainedBefore}&${retainedAfter}`;
    const callbackBase =
      `/?exportsBaseUrl=${encodeURIComponent(EXPORTS_ROOT)}` +
      `&dataset=${encodeURIComponent(FIRST_DATASET_ID)}` +
      '&acceptance=community-annotation-auth-callback';
    const startupOwned =
      'cellucid_github_auth=1&cellucid_github_token=secret-one' +
      '&cellucid_github_token=secret-two';
    await page.goto(
      `${callbackBase}#${retainedBefore}&${startupOwned}&${retainedAfter}`,
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await expect.poll(
      () => page.evaluate(() => window.location.hash),
    ).toBe(cleanedHash);
    await expect(
      page.locator('.notification-error').filter({
        hasText:
          'GitHub auth callback must contain exactly one token or one error',
      }),
    ).toHaveCount(1);

    const malformedCases = [
      {
        owned:
          'cellucid_github_auth=1&cellucid_github_auth=1' +
          '&cellucid_github_token=secret',
        message: 'flag must occur once',
      },
      {
        owned:
          'cellucid_github_auth=0&cellucid_github_token=secret',
        message: 'flag must occur once',
      },
      {
        owned: 'cellucid_github_auth=&cellucid_github_token=secret',
        message: 'flag must occur once',
      },
      {
        owned: 'cellucid_github_token=secret-without-flag',
        message: 'flag must occur once',
      },
      {
        owned: 'cellucid_github_error=denied-without-flag',
        message: 'flag must occur once',
      },
      {
        owned:
          'cellucid_github_auth=1&cellucid_github_token=secret-one' +
          '&%63ellucid_github_token=secret-two',
        message: 'exactly one token or one error',
      },
      {
        owned:
          'cellucid_github_auth=1&cellucid_github_error=first' +
          '&cellucid_github_error=second',
        message: 'exactly one token or one error',
      },
      {
        owned:
          'cellucid_github_auth=1&cellucid_github_token=secret' +
          '&cellucid_github_error=denied',
        message: 'exactly one token or one error',
      },
      {
        owned: 'cellucid_github_auth=1',
        message: 'exactly one token or one error',
      },
      {
        owned:
          'cellucid_github_auth=1&cellucid_github_token=%20secret',
        message: 'token must be an exact nonblank string',
      },
      {
        owned:
          'cellucid_github_auth=1&cellucid_github_error=denied%20',
        message: 'error must be an exact nonblank string',
      },
    ];
    for (const [index, entry] of malformedCases.entries()) {
      const outcome = await page.evaluate(
        async ({ cleanedHashValue, owned, retainedAfterValue,
          retainedBeforeValue, stateMarker }) => {
          const { getGitHubAuthSession } =
            await import(
              '/assets/js/app/community-annotations/github-auth.js'
            );
          const state = {
            marker: stateMarker,
            nested: { exact: true },
          };
          const callbackUrl =
            `${window.location.origin}${window.location.pathname}` +
            `${window.location.search}` +
            `#${retainedBeforeValue}&${owned}&${retainedAfterValue}`;
          window.history.replaceState(state, '', callbackUrl);
          let rejection = null;
          try {
            await getGitHubAuthSession().completeSignInFromRedirect();
          } catch (error) {
            rejection = {
              name: error?.name ?? null,
              message: error?.message ?? null,
              code: error?.code ?? null,
            };
          }
          return {
            authenticated: getGitHubAuthSession().isAuthenticated(),
            hash: window.location.hash,
            historyState: window.history.state,
            rejection,
            expectedHash: cleanedHashValue,
          };
        },
        {
          cleanedHashValue: cleanedHash,
          owned: entry.owned,
          retainedAfterValue: retainedAfter,
          retainedBeforeValue: retainedBefore,
          stateMarker: `malformed-${index}`,
        },
      );
      expect(outcome.hash).toBe(outcome.expectedHash);
      expect(outcome.historyState).toEqual({
        marker: `malformed-${index}`,
        nested: { exact: true },
      });
      expect(outcome.rejection?.message).toContain(entry.message);
      expect(outcome.authenticated).toBe(false);
      expect(outcome.hash).not.toContain('secret');
    }

    const emptyComponent = await page.evaluate(async () => {
      const { getGitHubAuthSession } =
        await import(
          '/assets/js/app/community-annotations/github-auth.js'
        );
      window.history.replaceState(
        { marker: 'empty-component' },
        '',
        `${window.location.origin}${window.location.pathname}` +
          `${window.location.search}` +
          '#&cellucid_github_auth=1' +
          '&cellucid_github_error=access_denied',
      );
      let rejectionCode = null;
      try {
        await getGitHubAuthSession().completeSignInFromRedirect();
      } catch (error) {
        rejectionCode = error?.code ?? null;
      }
      return {
        hash: window.location.hash,
        href: window.location.href,
        historyState: window.history.state,
        rejectionCode,
      };
    });
    expect(emptyComponent).toEqual({
      hash: '',
      href:
        `${APP_ORIGIN}/?exportsBaseUrl=${encodeURIComponent(EXPORTS_ROOT)}` +
        `&dataset=${encodeURIComponent(FIRST_DATASET_ID)}` +
        '&acceptance=community-annotation-auth-callback#',
      historyState: { marker: 'empty-component' },
      rejectionCode: 'GITHUB_AUTH_ERROR',
    });

    const denied = await page.evaluate(
      async ({ retainedAfterValue, retainedBeforeValue }) => {
        const { getGitHubAuthSession } =
          await import(
            '/assets/js/app/community-annotations/github-auth.js'
          );
        const state = { marker: 'valid-error' };
        window.history.replaceState(
          state,
          '',
          `${window.location.origin}${window.location.pathname}` +
            `${window.location.search}` +
            `#${retainedBeforeValue}` +
            '&cellucid_github_auth=1' +
            '&cellucid_github_error=access_denied' +
            `&${retainedAfterValue}`,
        );
        let rejection = null;
        try {
          await getGitHubAuthSession().completeSignInFromRedirect();
        } catch (error) {
          rejection = {
            message: error?.message ?? null,
            code: error?.code ?? null,
          };
        }
        return {
          authenticated: getGitHubAuthSession().isAuthenticated(),
          hash: window.location.hash,
          historyState: window.history.state,
          rejection,
        };
      },
      {
        retainedAfterValue: retainedAfter,
        retainedBeforeValue: retainedBefore,
      },
    );
    expect(denied).toEqual({
      authenticated: false,
      hash: cleanedHash,
      historyState: { marker: 'valid-error' },
      rejection: {
        message: 'access_denied',
        code: 'GITHUB_AUTH_ERROR',
      },
    });

    const accepted = await page.evaluate(
      async ({ retainedAfterValue, retainedBeforeValue }) => {
        const { getGitHubAuthSession } =
          await import(
            '/assets/js/app/community-annotations/github-auth.js'
          );
        const state = { marker: 'valid-token' };
        window.history.replaceState(
          state,
          '',
          `${window.location.origin}${window.location.pathname}` +
            `${window.location.search}` +
            `#${retainedBeforeValue}` +
            '&cellucid_github_auth=1' +
            '&cellucid_github_token=synthetic-token' +
            `&${retainedAfterValue}`,
        );
        const result =
          await getGitHubAuthSession().completeSignInFromRedirect();
        return {
          authenticated: getGitHubAuthSession().isAuthenticated(),
          hash: window.location.hash,
          historyState: window.history.state,
          result,
          stored:
            sessionStorage.getItem('cellucid:github-app-auth:session'),
        };
      },
      {
        retainedAfterValue: retainedAfter,
        retainedBeforeValue: retainedBefore,
      },
    );
    expect(accepted).toMatchObject({
      authenticated: true,
      hash: cleanedHash,
      historyState: { marker: 'valid-token' },
      result: {
        token: 'synthetic-token',
        user: AUTH_USER,
      },
    });
    expect(JSON.parse(accepted.stored)).toEqual({
      token: 'synthetic-token',
      user: AUTH_USER,
    });
    expect(authUserRequestHashes).toEqual([cleanedHash]);
    expect(pageErrors).toEqual([]);
  },
);
