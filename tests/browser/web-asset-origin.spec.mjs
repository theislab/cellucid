import { createHash } from 'node:crypto';

import { expect, test } from './helpers/test.mjs';

test('web origin serves every declared MIME family exactly', async ({
  request,
}) => {
  const inventoryResponse = await request.get('/cellucid-web-assets.json');
  expect(inventoryResponse.status()).toBe(200);
  expect(inventoryResponse.headers()['content-type']).toBe(
    'application/json; charset=utf-8'
  );
  const inventory = await inventoryResponse.json();
  expect(inventory.version).toBe(1);
  expect(Array.isArray(inventory.assets)).toBe(true);
  expect(
    inventory.assets.some(
      asset => asset.path === 'assets/img/og-preview.jpg'
    )
  ).toBe(false);

  const representativeByContentType = new Map();
  for (const asset of inventory.assets) {
    if (!representativeByContentType.has(asset.content_type)) {
      representativeByContentType.set(asset.content_type, asset);
    }
  }
  expect(representativeByContentType.size).toBeGreaterThan(0);

  for (const asset of representativeByContentType.values()) {
    const response = await request.head(`/${asset.path}`);
    expect(response.status(), asset.path).toBe(200);
    expect(response.headers()['content-type'], asset.path).toBe(
      asset.content_type
    );
    expect(response.headers()['content-length'], asset.path).toBe(
      String(asset.bytes)
    );
  }
});

// The suite's server rewrites the page it serves (it names the suite's own
// sample catalog), and a web cache given this origin as its source (the Python
// and R packages' `--web-source-url`) verifies every byte it fetches against
// the inventory fetched from the same origin: the page must be what the
// inventory says.
test('the page this origin serves is the one its inventory declares', async ({
  request,
}) => {
  const inventory = await (await request.get('/cellucid-web-assets.json')).json();
  const declared = inventory.assets.find(asset => asset.path === 'index.html');
  const page = await (await request.get('/index.html')).body();
  expect(page.length).toBe(declared.bytes);
  expect(createHash('sha256').update(page).digest('hex')).toBe(declared.sha256);
});
