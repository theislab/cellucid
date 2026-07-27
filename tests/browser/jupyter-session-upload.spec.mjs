import { expect, test } from '@playwright/test';

test('Jupyter session upload invokes the native browser fetch with its valid receiver', async ({
  page,
}) => {
  let uploadCount = 0;
  let contentType = null;
  await page.route(
    'http://127.0.0.1:4173/_cellucid/session_bundle?*',
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

  await page.evaluate(async () => {
    const { uploadJupyterSessionBundle } = await import(
      '/assets/js/data/jupyter-source.js'
    );
    await uploadJupyterSessionBundle({
      config: {
        serverUrl: 'http://127.0.0.1:4173',
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
  });

  expect(uploadCount).toBe(1);
  expect(contentType).toBe('application/octet-stream');
});
