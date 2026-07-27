import { expect, test } from '@playwright/test';

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
