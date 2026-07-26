import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  collectDOMReferences,
} from '../assets/js/app/ui/core/dom-cache.js';

const indexHtml = await readFile(
  new URL('../index.html', import.meta.url),
  'utf8'
);
const connectionSource = await readFile(
  new URL(
    '../assets/js/app/ui/modules/dataset-connections.js',
    import.meta.url
  ),
  'utf8'
);
const domCacheSource = await readFile(
  new URL(
    '../assets/js/app/ui/core/dom-cache.js',
    import.meta.url
  ),
  'utf8'
);
const formsCss = await readFile(
  new URL('../assets/css/components/_forms.css', import.meta.url),
  'utf8'
);

const BROWSER_IDENTITIES = Object.freeze({
  'Safari macOS':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  'Safari iOS':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  Chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  Edge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 ' +
    'Safari/537.36 Edg/138.0.0.0',
  Firefox:
    'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) ' +
    'Gecko/20100101 Firefox/140.0',
});

function staticZarrChooserContract(_userAgent) {
  return {
    directory:
      indexHtml.includes('id="user-data-zarr-btn"') ||
      indexHtml.includes('id="user-data-zarr-input"'),
    zip:
      indexHtml.includes('id="user-data-zarr-archive-btn"') &&
      indexHtml.includes('id="user-data-zarr-archive-input"'),
  };
}

test('the browser Zarr chooser is ZIP-only for every browser identity', async t => {
  for (const [browser, userAgent] of Object.entries(
    BROWSER_IDENTITIES
  )) {
    await t.test(browser, () => {
      assert.deepEqual(
        staticZarrChooserContract(userAgent),
        { directory: false, zip: true }
      );
    });
  }

  assert.doesNotMatch(
    connectionSource,
    /navigator\.(?:userAgent|userAgentData|vendor)/
  );
});

test('the portable Zarr chooser exposes exact guidance through the compact information popover', () => {
  const button = indexHtml.match(
    /<button\b[^>]*id="user-data-zarr-archive-btn"[^>]*>[\s\S]*?<\/button>/
  )?.[0];
  assert.ok(button, 'Zarr ZIP button is required');
  assert.match(button, />Zarr ZIP<\/button>/);
  assert.match(
    button,
    /title="[^"]*(?:portable|all supported browsers)[^"]*"/i
  );

  const archiveInput = indexHtml.match(
    /<input\b[^>]*id="user-data-zarr-archive-input"[^>]*>/
  )?.[0];
  assert.ok(archiveInput, 'Zarr ZIP file input is required');
  assert.match(archiveInput, /\btype="file"/);
  assert.match(archiveInput, /\baccept="[^"]*\.zip[^"]*"/);
  assert.doesNotMatch(
    archiveInput,
    /\b(?:webkitdirectory|directory|multiple)\b/
  );

  const infoButton = indexHtml.match(
    /<button\b[^>]*id="user-data-info-btn"[^>]*>[\s\S]*?<\/button>/
  )?.[0];
  assert.ok(infoButton, 'local data information button is required');
  assert.match(infoButton, /\btype="button"/);
  assert.match(infoButton, /\baria-controls="user-data-info-tooltip"/);
  assert.match(infoButton, /\baria-expanded="false"/);
  assert.match(infoButton, /\baria-haspopup="dialog"/);

  const popover = indexHtml.match(
    /<div\b[^>]*id="user-data-info-tooltip"[^>]*>[\s\S]*?<\/div>\s*<\/div>/
  )?.[0];
  assert.ok(popover, 'local data information popover is required');
  assert.match(popover, /\brole="dialog"/);
  assert.match(popover, /\baria-labelledby="user-data-info-btn"/);
  assert.match(popover, /\btabindex="-1"/);
  assert.match(popover, /\bhidden\b/);
  assert.match(popover, /\.zarr\.zip/i);
  for (const browser of [
    'Safari',
    'Chrome',
    'Edge',
    'Firefox',
  ]) {
    assert.match(popover, new RegExp(browser, 'i'));
  }

  assert.doesNotMatch(indexHtml, /id="user-data-zarr-help"/);
  assert.doesNotMatch(indexHtml, /Zarr folder/i);
  assert.doesNotMatch(indexHtml, /user-data-zarr-(?:btn|input)/);
});

test('DOM and event wiring expose no browser directory-load branch', () => {
  assert.doesNotMatch(
    domCacheSource,
    /userDataZarr(?:Btn|Input)/
  );
  assert.doesNotMatch(
    connectionSource,
    /userDataZarr(?:Btn|Input)|loadFromZarrDirectory|LOCAL_ZARR_DIRECTORY/
  );
  assert.match(
    connectionSource,
    /source\.loadFromZarrArchive\([\s\S]*files\.length === 1 \? files\[0\] : null/
  );
  assert.match(connectionSource, /LOCAL_ZARR_ZIP/);

  const requestedIds = [];
  const dom = collectDOMReferences({
    getElementById(id) {
      requestedIds.push(id);
      return { id };
    },
  });
  assert.equal(
    dom.dataset.userDataZarrArchiveBtn.id,
    'user-data-zarr-archive-btn'
  );
  assert.equal(
    dom.dataset.userDataZarrArchiveInput.id,
    'user-data-zarr-archive-input'
  );
  assert.equal(
    Object.hasOwn(dom.dataset, 'userDataZarrBtn'),
    false
  );
  assert.equal(
    Object.hasOwn(dom.dataset, 'userDataZarrInput'),
    false
  );
  assert.equal(requestedIds.includes('user-data-zarr-btn'), false);
  assert.equal(requestedIds.includes('user-data-zarr-input'), false);
});

test('three local-data actions retain a balanced narrow-sidebar layout', () => {
  assert.match(
    formsCss,
    /\.user-data-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(
    formsCss,
    /\.user-data-grid \.data-btn-wide\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1/
  );
  assert.doesNotMatch(formsCss, /\.user-data-help\b/);
});
