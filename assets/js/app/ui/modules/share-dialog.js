/**
 * @fileoverview Share this dataset: a link, an "Open in Cellucid" badge and an
 * embed snippet.
 *
 * Offered only for a dataset that a URL can reopen for someone else: a sample
 * dataset, a GitHub-hosted export, or a server that is not this computer. A
 * file opened from disk, a notebook session and a server on localhost have no
 * such URL, so the Share button stays hidden for them.
 *
 * Every snippet points at the public site, whatever origin this copy of the
 * app is served from, and carries only the data-source parameters
 * (`url-state.js` owns that list).
 *
 * @module ui/modules/share-dialog
 */

import { readDataSourceUrlParameters } from '../../url-state.js';
import { copyWithFeedback, wireAppDialog } from '../components/app-dialog.js';

export const PUBLIC_APP_URL = 'https://www.cellucid.com/';
export const BADGE_IMAGE_URL = `${PUBLIC_APP_URL}assets/img/open-in-cellucid.svg`;
const SHAREABLE_SOURCE_TYPES = new Set(['local-demo', 'remote', 'link']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

function escapeAttribute(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function isLoopbackServer(serverUrl) {
  try {
    const { hostname } = new URL(serverUrl);
    return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
  } catch {
    return true;
  }
}

/**
 * The public link that reopens the current dataset, or null when there is none.
 *
 * @param {string|null} sourceType - The active data source's type.
 * @param {string} href - The page URL.
 * @returns {string|null}
 */
export function buildShareUrl(sourceType, href) {
  if (!SHAREABLE_SOURCE_TYPES.has(sourceType)) return null;
  const params = readDataSourceUrlParameters(href);
  if (sourceType === 'link') {
    // A link names its own dataset when it holds one; a loopback web address
    // reopens only on this computer.
    const locator = params.get('data');
    if (locator === null) return null;
    if (/^https?:\/\//i.test(locator) && isLoopbackServer(locator)) return null;
    return `${PUBLIC_APP_URL}?${params.toString()}`;
  }
  if (!params.has('dataset')) return null;
  if (sourceType === 'remote') {
    const server = params.get('remote');
    if (server === null || isLoopbackServer(server)) return null;
  }
  if (sourceType === 'local-demo' && params.get('source') !== 'local-demo') {
    params.set('source', 'local-demo');
  }
  return `${PUBLIC_APP_URL}?${params.toString()}`;
}

export function badgeMarkdown(shareUrl) {
  return `[![Open in Cellucid](${BADGE_IMAGE_URL})](${shareUrl})`;
}

export function embedHtml(shareUrl, datasetName) {
  const title = datasetName ? `Cellucid: ${datasetName}` : 'Cellucid';
  return `<iframe src="${escapeAttribute(shareUrl)}" title="${escapeAttribute(title)}" `
    + 'width="100%" height="640" style="border: 0;" allow="fullscreen" loading="lazy"></iframe>';
}

export function initShareDialog({ ownerDocument = document, dataSourceManager }) {
  if (dataSourceManager === null || typeof dataSourceManager?.getCurrentSourceType !== 'function') {
    throw new TypeError('Share needs the data source manager.');
  }
  const byId = id => {
    const element = ownerDocument.getElementById(id);
    if (element === null) throw new TypeError(`Share dialog requires #${id}.`);
    return element;
  };
  const button = byId('share-dataset-btn');
  const dialog = byId('share-dialog');
  const link = byId('share-link');
  const badge = byId('share-badge');
  const embed = byId('share-embed');
  const owner = wireAppDialog(dialog);
  const controller = new AbortController();
  let shareUrl = null;

  function currentShareUrl() {
    let sourceType = null;
    try {
      sourceType = dataSourceManager.getCurrentSourceType();
    } catch {
      return null;
    }
    return buildShareUrl(sourceType, ownerDocument.defaultView.location.href);
  }

  function refresh() {
    shareUrl = currentShareUrl();
    button.hidden = shareUrl === null;
    if (shareUrl === null && dialog.open) owner.close();
  }

  button.addEventListener('click', () => {
    refresh();
    if (shareUrl === null) return;
    const name = dataSourceManager.getCurrentMetadata?.()?.name ?? '';
    link.value = shareUrl;
    badge.value = badgeMarkdown(shareUrl);
    embed.value = embedHtml(shareUrl, name);
    owner.open(button);
  }, { signal: controller.signal });

  for (const copy of dialog.querySelectorAll('[data-copy-from]')) {
    copy.addEventListener('click', () => {
      const source = byId(copy.dataset.copyFrom);
      void copyWithFeedback(copy, source.value);
    }, { signal: controller.signal });
  }
  // Selecting a field selects all of it, so a manual copy takes the whole snippet.
  for (const field of [link, badge, embed]) {
    field.addEventListener('focus', () => field.select(), { signal: controller.signal });
  }

  refresh();
  return {
    refresh,
    destroy() {
      controller.abort();
      owner.destroy();
    },
  };
}
