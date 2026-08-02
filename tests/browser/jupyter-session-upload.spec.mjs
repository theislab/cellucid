import { expect, test } from '@playwright/test';
import { APP_ORIGIN } from './helpers/origins.mjs';

test('Jupyter bridge owns authenticated parent traffic for its live lifecycle', async ({
  page,
}) => {
  await page.route('**/_cellucid/health', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        type: 'exported',
        version: '0.9.1',
      }),
    });
  });
  await page.goto('/?acceptance=jupyter-lifecycle', {
    waitUntil: 'domcontentloaded',
  });

  const result = await page.evaluate(async () => {
    const { JupyterBridgeDataSource } = await import(
      '/assets/js/data/jupyter-source.js'
    );
    const source = new JupyterBridgeDataSource({
      serverUrl: window.location.origin,
      viewerId: 'viewer-browser-lifecycle',
      viewerToken: 'token-browser-lifecycle',
    });
    const delivered = [];
    const reportedFailures = [];
    source.onMessage(message => {
      delivered.push(message.type);
      if (message.type === 'requestSessionBundle') {
        return Promise.reject(
          new Error('browser async notebook callback failed')
        );
      }
      return undefined;
    });
    source._reportMessageFailure = error => {
      reportedFailures.push(error.message);
    };

    const availableBeforeHealth = await source.isAvailable();
    await source.initialize();
    const availableAfterHealth = await source.isAvailable();
    const authenticated = {
      viewerId: 'viewer-browser-lifecycle',
      viewerToken: 'token-browser-lifecycle',
    };

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'freeze', ...authenticated },
      origin: window.location.origin,
      source: null,
    }));
    const deliveredAfterForeignSource = [...delivered];

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'freeze', ...authenticated },
      origin: window.location.origin,
      source: window,
    }));
    const deliveredAfterParentSource = [...delivered];

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'requestSessionBundle',
        requestId: 'browser-request',
        ...authenticated,
      },
      origin: window.location.origin,
      source: window,
    }));
    await new Promise(resolve => setTimeout(resolve, 0));

    source.disconnect();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'freeze', ...authenticated },
      origin: window.location.origin,
      source: window,
    }));
    await new Promise(resolve => setTimeout(resolve, 0));

    return {
      availableBeforeHealth,
      availableAfterHealth,
      deliveredAfterForeignSource,
      deliveredAfterParentSource,
      deliveredAfterDisconnect: delivered,
      reportedFailures,
      connectedAfterDisconnect: source.isConnected(),
    };
  });

  expect(result).toEqual({
    availableBeforeHealth: false,
    availableAfterHealth: true,
    deliveredAfterForeignSource: [],
    deliveredAfterParentSource: ['freeze'],
    deliveredAfterDisconnect: ['freeze', 'requestSessionBundle'],
    reportedFailures: ['browser async notebook callback failed'],
    connectedAfterDisconnect: false,
  });
});

test('Jupyter session upload invokes the native browser fetch with its valid receiver', async ({
  page,
}) => {
  let uploadCount = 0;
  let contentType = null;
  await page.route(
    `${APP_ORIGIN}/_cellucid/session_bundle?*`,
    async route => {
      uploadCount++;
      contentType = await route.request().headerValue('content-type');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          bytes: 3,
        }),
      });
    }
  );
  await page.goto('/?acceptance=jupyter-native-fetch', {
    waitUntil: 'domcontentloaded',
  });

  // The origin is resolved in Node and handed to the page, because the page has
  // no access to the test module's bindings.
  await page.evaluate(async serverUrl => {
    const { uploadJupyterSessionBundle } = await import(
      '/assets/js/data/jupyter-source.js'
    );
    await uploadJupyterSessionBundle({
      config: {
        serverUrl,
        viewerId: 'viewer-native-fetch',
        viewerToken: 'token-native-fetch',
      },
      message: {
        type: 'requestSessionBundle',
        requestId: 'request-native-fetch',
        viewerId: 'viewer-native-fetch',
        viewerToken: 'token-native-fetch',
      },
      createSessionBundle: async () =>
        new Blob([Uint8Array.of(1, 2, 3)]),
      fetchImpl: window.fetch,
    });
  }, APP_ORIGIN);

  expect(uploadCount).toBe(1);
  expect(contentType).toBe('application/octet-stream');
});
