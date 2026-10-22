/**
 * Which datasets a link can reopen for someone else, and what the snippets say.
 *
 * `buildShareUrl` decides whether the Share button exists at all: a sample, a
 * GitHub export and a reachable server can be reopened from a URL; a file from
 * disk, a notebook and a server on this computer cannot, and offering a link
 * that opens nothing for its recipient would be worse than no button.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BADGE_IMAGE_URL,
  PUBLIC_APP_URL,
  badgeMarkdown,
  buildShareUrl,
  embedHtml,
} from '../assets/js/app/ui/modules/share-dialog.js';

const page = query => `http://127.0.0.1:8765/?${query}`;

test('samples, GitHub exports and reachable servers are shareable', () => {
  assert.equal(
    buildShareUrl('local-demo', page('source=local-demo&dataset=pancreas&exportsBaseUrl=x')),
    `${PUBLIC_APP_URL}?dataset=pancreas&source=local-demo`,
  );
  assert.equal(
    buildShareUrl('github-repo', page('github=owner%2Frepo%2Fexports&dataset=atlas')),
    `${PUBLIC_APP_URL}?dataset=atlas&github=owner%2Frepo%2Fexports`,
  );
  assert.equal(
    buildShareUrl('remote', page('remote=https%3A%2F%2Fdata.example.org&dataset=served')),
    `${PUBLIC_APP_URL}?dataset=served&remote=https%3A%2F%2Fdata.example.org`,
  );
});

test('a file, a notebook and a server on this computer have no link', () => {
  assert.equal(buildShareUrl('local-user', page('')), null);
  assert.equal(buildShareUrl('jupyter', page('dataset=x')), null);
  assert.equal(buildShareUrl(null, page('dataset=x')), null);
  for (const host of ['http://localhost:8765', 'http://127.0.0.1:8765', 'http://[::1]:8765', 'http://lab.localhost']) {
    assert.equal(
      buildShareUrl('remote', page(`remote=${encodeURIComponent(host)}&dataset=served`)),
      null,
      host,
    );
  }
  assert.equal(buildShareUrl('github-repo', page('dataset=atlas')), null, 'no repository');
  assert.equal(buildShareUrl('local-demo', page('source=local-demo')), null, 'no dataset');
});

test('the badge and the embed carry exactly the link', () => {
  const url = `${PUBLIC_APP_URL}?dataset=atlas&github=owner%2Frepo`;
  assert.equal(badgeMarkdown(url), `[![Open in Cellucid](${BADGE_IMAGE_URL})](${url})`);
  const embed = embedHtml(url, 'Atlas "v2"');
  assert.match(embed, /^<iframe src="https:\/\/www\.cellucid\.com\/\?dataset=atlas&amp;github=owner%2Frepo" /);
  assert.match(embed, /title="Cellucid: Atlas &quot;v2&quot;"/);
  assert.match(embed, /width="100%" height="640"/);
  assert.match(embed, /allow="fullscreen" loading="lazy"><\/iframe>$/);
});
