import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { publishWebBuildVersion } from '../assets/js/app/ui/core/build-version.js';

const INDEX_URL = new URL('../index.html', import.meta.url);

function createDocument(buildIds, versions = ['0.9.4']) {
  const output = { textContent: '', title: '' };
  const versionOutput = { textContent: '', title: '' };
  const metas = {
    'meta[name="cellucid-web-build-id"]': buildIds,
    'meta[name="cellucid-version"]': versions,
  };
  return {
    output,
    versionOutput,
    querySelectorAll(selector) {
      assert.ok(selector in metas, selector);
      return metas[selector].map(value => ({
        getAttribute(name) {
          assert.equal(name, 'content');
          return value;
        },
      }));
    },
    getElementById(id) {
      if (id === 'web-build-version') return output;
      if (id === 'web-version') return versionOutput;
      assert.fail(`unexpected element ${id}`);
      return null;
    },
  };
}

test('footer publishes the one exact web build identity and the shared release version', () => {
  const documentOwner = createDocument(['2026-07-27.10'], ['1.2.3']);
  assert.equal(publishWebBuildVersion(documentOwner), '2026-07-27.10');
  assert.equal(documentOwner.output.textContent, '2026-07-27.10');
  assert.equal(documentOwner.output.title, 'Website build 2026-07-27.10');
  assert.equal(documentOwner.versionOutput.textContent, '1.2.3');
  assert.equal(documentOwner.versionOutput.title, 'Cellucid 1.2.3');
});

test('web build publication rejects missing, duplicate, and malformed identities', () => {
  assert.throws(
    () => publishWebBuildVersion(createDocument([])),
    /exactly one build-id meta/i,
  );
  assert.throws(
    () => publishWebBuildVersion(createDocument(['one', 'two'])),
    /exactly one build-id meta/i,
  );
  assert.throws(
    () => publishWebBuildVersion(createDocument(['bad build'])),
    /canonical build id/i,
  );
  assert.throws(
    () => publishWebBuildVersion(createDocument(['2026-07-27.10'], [])),
    /exactly one version meta/i,
  );
  assert.throws(
    () => publishWebBuildVersion(createDocument(['2026-07-27.10'], ['v1'])),
    /one release version/i,
  );
});

test('HTML owns visible build output and collapsed optional network/camera sections', async () => {
  const html = await readFile(INDEX_URL, 'utf8');
  assert.match(
    html,
    /<span id="web-version" aria-label="Cellucid version"><\/span> · Build <span id="web-build-version" aria-label="Website build version"><\/span>/,
  );
  // The page declares the release version once, marked for the bump sweep,
  // and the citation file declares the same one.
  const metaVersion = html.match(/<meta name="cellucid-version" content="([^"]+)" \/> <!-- CELLUCID_VERSION -->/);
  assert.ok(metaVersion, 'the page declares the shared release version');
  const citation = await readFile(new URL('../CITATION.cff', import.meta.url), 'utf8');
  assert.match(citation, new RegExp(`^version: ${metaVersion[1].replace(/\./g, '\\.')}  # CELLUCID_VERSION$`, 'm'));
  assert.match(
    html,
    /<details class="accordion-section" id="community-annotation-section" data-state-serializer-skip="true">/,
  );
  assert.match(
    html,
    /<details class="accordion-section" id="cinematic-camera-section" data-state-serializer-skip="true">/,
  );
});
