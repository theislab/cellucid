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
 * (`url-state.js` owns that list), a data link in its public form: what the
 * link carries to grant access (a share key, a signature, a token) stays in
 * this page's address and is never shared; the dialog says so when it left
 * something out.
 *
 * An agent, a notebook and a replay get the same link and snippets with
 * `dataset.share-link` (asked of an agent as `publishes`: the link goes to
 * the agent, and from there wherever it is sent).
 *
 * @module ui/modules/share-dialog
 */

import { dataLinkLeavesOutAccess, readDataSourceUrlParameters } from '../../url-state.js';
import { copyWithFeedback, wireAppDialog } from '../components/app-dialog.js';
import { ActionRefused } from '../../actions/dispatcher.js';

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

/**
 * @param {{ownerDocument?: Document, dataSourceManager: object,
 *   actions?: {provide: (type: string, handler: Function) => () => void}|null}} options -
 *   `actions`: the page's dispatcher, on which the dialog's link is provided as `dataset.share-link`
 */
export function initShareDialog({ ownerDocument = document, dataSourceManager, actions = null }) {
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
  const accessNote = byId('share-access-note');
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
    const made = snippets(shareUrl);
    link.value = made.link;
    accessNote.hidden = !made.accessLeftOut;
    badge.value = made.badge;
    embed.value = made.embed;
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

  /** What the dialog shows for the dataset shown: the link, the badge, the embed snippet, and whether access was left out. */
  function snippets(url) {
    const name = dataSourceManager.getCurrentMetadata?.()?.name ?? '';
    return {
      link: url,
      badge: badgeMarkdown(url),
      embed: embedHtml(url, name),
      accessLeftOut: dataLinkLeavesOutAccess(ownerDocument.defaultView.location.href),
    };
  }

  // An agent's, a notebook's or a replay's Share (`dataset.share-link`): the dialog's link and snippets.
  const unprovide = actions === null ? () => {} : actions.provide('dataset.share-link', () => {
    const url = currentShareUrl();
    if (url === null) {
      throw new ActionRefused(
        'The dataset shown has no link that opens it for someone else (a file of this computer, a notebook\'s dataset or a server on this computer): the person shares the file itself.',
        { code: 'unavailable', type: 'dataset.share-link' },
      );
    }
    const made = snippets(url);
    return { link: made.link, badge: made.badge, embed: made.embed, access_left_out: made.accessLeftOut };
  });

  refresh();
  return {
    refresh,
    destroy() {
      unprovide();
      controller.abort();
      owner.destroy();
    },
  };
}
