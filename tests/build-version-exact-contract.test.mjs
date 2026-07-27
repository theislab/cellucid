import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { publishWebBuildVersion } from '../assets/js/app/ui/core/build-version.js';

const INDEX_URL = new URL('../index.html', import.meta.url);

function createDocument(buildIds) {
  const output = { textContent: '', title: '' };
  return {
    output,
    querySelectorAll(selector) {
      assert.equal(selector, 'meta[name="cellucid-web-build-id"]');
      return buildIds.map(buildId => ({
        getAttribute(name) {
          assert.equal(name, 'content');
          return buildId;
        },
      }));
    },
    getElementById(id) {
      assert.equal(id, 'web-build-version');
      return output;
    },
  };
}

test('footer publishes the one exact web build identity', () => {
  const documentOwner = createDocument(['2026-07-27.10']);
  assert.equal(publishWebBuildVersion(documentOwner), '2026-07-27.10');
  assert.equal(documentOwner.output.textContent, '2026-07-27.10');
  assert.equal(documentOwner.output.title, 'Website build 2026-07-27.10');
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
});

test('HTML owns visible build output and collapsed optional network/camera sections', async () => {
  const html = await readFile(INDEX_URL, 'utf8');
  assert.match(
    html,
    /<span id="web-build-version" aria-label="Website build version"><\/span>/,
  );
  assert.match(
    html,
    /<details class="accordion-section" id="community-annotation-section" data-state-serializer-skip="true">/,
  );
  assert.match(
    html,
    /<details class="accordion-section" id="cinematic-camera-section" data-state-serializer-skip="true">/,
  );
});
