/**
 * OneDrive and SharePoint files (any single-file input format: an `.h5ad`, a
 * Zarr ZIP, a `.loom`, …), read in place.
 *
 * OneDrive serves no file to an anonymous visitor any more, not even one
 * shared with anyone who has the link, so every OneDrive file opens after a
 * Microsoft sign-in (personal, work or school: `auth/microsoft.js`). Then:
 *
 * 1. Microsoft Graph names the file, its size, its version (`cTag`) and a
 *    pre-authenticated download URL, in one request for the whole item
 *    (`DOWNLOAD_URL`: a `$select` drops the URL). A share link is
 *    redeemed durably (`Prefer: redeemSharingLink`), as opening it in a
 *    browser does: the file joins "Shared with me", and the link opens
 *    afterwards by its drive and item ids, so sessions and `?data=` never
 *    carry the share link.
 * 2. The download URL is read with plain range requests: no token, no
 *    preflight. It expires within minutes; the page asks Graph for a new one
 *    when an answer says it went stale (`sources/access.js`), once for every
 *    read waiting on it, and refreshes it ahead of time once its lifetime has
 *    been seen. A file that changed on OneDrive meanwhile is refused rather
 *    than mixed.
 *
 * A work or school account reads its own files with `Files.Read`; a file a
 * colleague shared needs `Files.Read.All`, asked for only then ("[Ask for
 * access]"), which many organisations let only an administrator approve.
 *
 * Accepts `1drv.ms/…` share links, `onedrive.live.com/…` links,
 * `<tenant>-my.sharepoint.com/:u:/…` and `<tenant>.sharepoint.com/:u:/…`
 * share links, `onedrive:<drive id>/<item id>` and `onedrive:u!<encoded link>`.
 * Folder links are refused: share the file itself.
 *
 * @module data/sources/providers/onedrive
 */

import { DataSourceError, DataSourceErrorCode, explainedFailure } from '../../data-source.js';
import { describeRemoteFile } from '../remote-file.js';
import { requestJson } from '../api-request.js';
import { registerSourceAccess, revokeSourceAccess } from '../access.js';
import { getMicrosoftAuth } from '../auth/microsoft.js';
import { BYTE_SOURCE_FAILURES, HEAD_BYTES, headOfFile, readFileHead } from '../../../formats/io/byte-source.js';
import { openableNamesText } from '../../input-formats.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
/**
 * The pre-authenticated download URL Graph names beside a file's item. It is
 * asked for by asking for the whole item, with no `$select`: Graph leaves
 * the annotation out of an answer whose fields are selected, even when the
 * selection names it (seen 2026-10-25 on a personal OneDrive's
 * `/shares/{id}/driveItem`: `$select=…,@microsoft.graph.downloadUrl` answered
 * every other field it named). The whole item is a few kilobytes, in the
 * same one request; following `/content` to its redirect instead would cost
 * a second round trip and a range request of the file to learn the URL.
 */
const DOWNLOAD_URL = '@microsoft.graph.downloadUrl';
/** Answers of the download host that mean its URL expired (OneDrive's `tempauth`). */
const STALE_DOWNLOAD = Object.freeze([401, 403, 404]);

function base64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Graph's share id of a sharing link: `u!` and the link in base64url. */
export function shareIdOf(link) {
  return `u!${base64Url(link)}`;
}

const SHARE_ID = /^u![A-Za-z0-9_-]+$/;
const DRIVE_ITEM = /^([A-Za-z0-9!_.-]+)\/([A-Za-z0-9!_.-]+)$/;

/**
 * `u!<share>`, `<drive>/<item>`, `folder:<link>`, `page:<link>` (a OneDrive
 * or SharePoint page that is not a share link: its file list, or a file
 * opened in it), or null.
 */
export function parseOneDrive(input, explicit = true) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (explicit) {
    if (SHARE_ID.test(text) || DRIVE_ITEM.test(text)) return text;
    if (/^(folder|page):https:\/\//.test(text)) return text;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const share = () => {
    url.hash = '';
    return shareIdOf(url.href);
  };
  if (host === '1drv.ms') {
    const kind = /^\/([a-z])\//.exec(path)?.[1] ?? null;
    if (kind === null) return null;
    return kind === 'f' ? `folder:${url.origin}${path}` : share();
  }
  if (host === 'onedrive.live.com') {
    // The owner's own view: the drive (cid) and the item (id or resid).
    const item = url.searchParams.get('resid') ?? url.searchParams.get('id');
    const cid = url.searchParams.get('cid');
    if (url.searchParams.has('redeem')) return share();
    if (/^\/:f:\//.test(path)) return `folder:${url.origin}${path}`;
    if (/^\/:[a-z]:\//.test(path)) return share();
    if (item !== null && cid !== null && DRIVE_ITEM.test(`${cid}/${item}`)) return `${cid.toLowerCase()}/${item}`;
    return `page:${url.origin}${path}`;
  }
  if (host.endsWith('.sharepoint.com')) {
    if (/^\/:f:\//.test(path)) return `folder:${url.origin}${path}`;
    if (/^\/:[a-z]:\//.test(path)) return share();
    if (/\/_layouts\/15\/onedrive\.aspx$/i.test(path)) return `page:${url.origin}${path}`;
    return null;
  }
  return null;
}

/**
 * A refusal written for the person (what is wrong, what to do): shown as it
 * is wherever it arrives (`explainedFailure`).
 */
function refusal(message, code, details = {}) {
  return explainedFailure(message, code, 'link', details);
}

const PAGE_REFUSAL =
  'This is the address of a OneDrive page, not a link to a file. In OneDrive, select the file, click Share, ' +
  'then Copy link, and paste that link.';

const FOLDER_REFUSAL =
  'This link is a OneDrive folder. Cellucid opens single files from OneDrive: share the file itself ' +
  `(${openableNamesText({ layouts: ['file', 'zip'] })}) and paste its link.`;

/**
 * The OneDrive provider, given its Microsoft sign-in (`auth/microsoft.js`).
 *
 * @param {{microsoft?: ReturnType<import('../auth/microsoft.js').createMicrosoftAuth>, now?: () => number}} [options]
 */
export function createOneDriveProvider({ microsoft = null, now = () => Date.now() } = {}) {
  const auth = () => microsoft ?? getMicrosoftAuth();

  /** The item's address in Graph: the whole item, which names its download URL (`DOWNLOAD_URL`). */
  function itemUrl(parsed) {
    return SHARE_ID.test(parsed)
      ? `${GRAPH}/shares/${parsed}/driveItem`
      : `${GRAPH}/drives/${encodeURIComponent(parsed.split('/')[0])}/items/${encodeURIComponent(parsed.split('/')[1])}`;
  }

  /**
   * The item, signed in: renewed once when the token was refused, and asked
   * for with `Files.Read.All` when the account cannot see the file with
   * `Files.Read` (a colleague's file).
   */
  async function readItem(parsed, { signal = null, onStep = null, interactive = true } = {}) {
    const microsoftAuth = auth();
    let more = microsoftAuth.hasWideAccess();
    if (!microsoftAuth.signedIn()) onStep?.('Waiting for you to sign in with Microsoft');
    let token = await microsoftAuth.authorize({
      kind: interactive ? 'sign-in' : 'expired',
      text: interactive ? 'OneDrive file: sign in with Microsoft to open it.' : 'Microsoft sign-in expired.',
      more,
      signal,
    });
    for (let renewed = false; ; ) {
      const answer = await requestJson(itemUrl(parsed), {
        label: 'Microsoft Graph',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(SHARE_ID.test(parsed) ? { Prefer: 'redeemSharingLink' } : {}),
        },
        signal,
      });
      if (answer.ok) return answer.body ?? {};
      if (answer.status === 401 && !renewed) {
        renewed = true;
        microsoftAuth.refused(token);
        token = await microsoftAuth.authorize({ kind: 'expired', text: 'Microsoft sign-in expired.', more, signal });
        continue;
      }
      if ((answer.status === 403 || answer.status === 404) && !more && interactive) {
        more = true;
        onStep?.('Waiting for you to allow Cellucid to read files shared with you');
        token = await microsoftAuth.authorize({
          kind: 'more-access',
          text: 'This file may belong to someone else in your organisation. Reading it needs your permission ' +
            'to read files shared with you; your organisation may need to approve Cellucid.',
          more: true,
          signal,
        });
        continue;
      }
      if (answer.status === 403 || answer.status === 404) {
        throw refusal(
          'Your Microsoft account cannot open this file: it was not shared with you, the link is wrong, or ' +
          'your organisation does not allow sharing with you. Ask its owner to share it with your account.',
          DataSourceErrorCode.PERMISSION_DENIED,
          { status: answer.status }
        );
      }
      throw new DataSourceError(
        `Microsoft Graph could not read the file (HTTP ${answer.status}).`,
        DataSourceErrorCode.NETWORK_ERROR,
        'link',
        { status: answer.status }
      );
    }
  }

  /**
   * The reads of one file: its download URL, replaced through Graph when it
   * went stale, and ahead of time once its lifetime has been seen.
   */
  function downloadAccess(ids, first, issuedAt, name) {
    let url = first.url;
    let cTag = first.cTag;
    let issued = issuedAt;
    /** How long a download URL was seen to work, and what renewing it costs. */
    let lifetimeMs = null;
    let renewMs = 0;
    return registerSourceAccess({
      provider: 'onedrive',
      stale: [...STALE_DOWNLOAD],
      target: async ({ refresh }) => {
        if (refresh) {
          // Seen to expire: renewed ahead of time from now on.
          if (lifetimeMs === null || now() - issued < lifetimeMs) lifetimeMs = now() - issued;
          const askedAt = now();
          const item = await readItem(ids, { interactive: false });
          renewMs = now() - askedAt;
          if (item.cTag !== cTag) {
            const error = new Error(`${name} changed on OneDrive while it was open; open it again to read the new version.`);
            error.code = BYTE_SOURCE_FAILURES.CHANGED;
            throw error;
          }
          if (typeof item[DOWNLOAD_URL] !== 'string') {
            throw new Error(`Microsoft Graph answered without a download address for ${name}, so it cannot be read on; open it again.`);
          }
          url = item[DOWNLOAD_URL];
          cTag = item.cTag;
          issued = askedAt;
        }
        return {
          url,
          ...(lifetimeMs === null ? {} : { expiresAt: issued + lifetimeMs - renewMs }),
        };
      },
    });
  }

  async function signIn() {
    return auth().authorize({ kind: 'sign-in' });
  }

  function signOut() {
    auth().signOut();
    revokeSourceAccess('onedrive');
  }

  return Object.freeze({
    id: 'onedrive',
    label: 'OneDrive',
    capabilities: Object.freeze({
      folders: false,
      private: 'sign-in',
      versions: false,
      write: false,
    }),
    auth: Object.freeze({
      signIn,
      signOut,
      authorize: () => auth().silentToken(),
    }),
    match(input, { explicit = true } = {}) {
      return parseOneDrive(input, explicit);
    },
    async open(value, { signal = null, onStep = null } = {}) {
      const parsed = parseOneDrive(value);
      if (parsed === null) {
        throw refusal(`"${value}" is not a OneDrive or SharePoint file link.`, DataSourceErrorCode.INVALID_FORMAT, { input: value });
      }
      if (parsed.startsWith('folder:')) throw refusal(FOLDER_REFUSAL, DataSourceErrorCode.UNSUPPORTED, { input: value });
      if (parsed.startsWith('page:')) throw refusal(PAGE_REFUSAL, DataSourceErrorCode.INVALID_FORMAT, { input: value });
      const noSignIn = auth().whyNoSignIn();
      if (noSignIn !== null) {
        throw refusal(
          `OneDrive files open only after a Microsoft sign-in. ${noSignIn}`,
          DataSourceErrorCode.UNSUPPORTED,
          { input: value }
        );
      }
      onStep?.('Reading the file\'s details on OneDrive');
      const askedAt = now();
      const item = await readItem(parsed, { signal, onStep });
      if (item.folder !== undefined) throw refusal(FOLDER_REFUSAL, DataSourceErrorCode.UNSUPPORTED, { input: value });
      const driveId = item.parentReference?.driveId;
      const name = String(item.name ?? '');
      if (item.file === undefined) {
        // A OneNote notebook, a SharePoint list item, …: a drive item that holds no file.
        throw refusal(
          `${name || 'This item'} is not a file on OneDrive (it is a ${item.package?.type ?? 'drive item'} with no ` +
          `file content). Share the file itself (${openableNamesText({ layouts: ['file', 'zip'] })}).`,
          DataSourceErrorCode.UNSUPPORTED,
          { input: value }
        );
      }
      if (typeof driveId !== 'string' || typeof item.id !== 'string' || typeof item[DOWNLOAD_URL] !== 'string') {
        // Graph's answer, not the file, is what is missing: say so.
        const missing = [
          ...(typeof driveId !== 'string' ? ['its drive'] : []),
          ...(typeof item.id !== 'string' ? ['its id'] : []),
          ...(typeof item[DOWNLOAD_URL] !== 'string' ? ['a download address'] : []),
        ];
        throw refusal(
          `Microsoft Graph described ${name || 'the file'} without ${missing.join(' or ')}, so Cellucid cannot read ` +
          'it. Try again in a moment; if this stays, report it with the link.',
          DataSourceErrorCode.NETWORK_ERROR,
          { input: value, missing }
        );
      }
      const ids = `${driveId}/${item.id}`;
      const size = Number(item.size);
      // The first bytes, straight from the download URL: no token, no preflight.
      let head = null;
      if (Number.isSafeInteger(size)) {
        try {
          head = headOfFile(await readFileHead(item[DOWNLOAD_URL], HEAD_BYTES, { signal }), size, HEAD_BYTES);
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
      const access = downloadAccess(ids, { url: item[DOWNLOAD_URL], cTag: item.cTag }, askedAt, name);
      const display = `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/content`;
      const described = await describeRemoteFile({
        url: display,
        id: `onedrive:${encodeURIComponent(driveId)}:${encodeURIComponent(item.id)}`,
        name,
        size: Number.isSafeInteger(size) ? size : null,
        head,
        version: `ctag:${item.cTag ?? ''}:${size}`,
        attribution: { title: name, url: typeof item.webUrl === 'string' ? item.webUrl : display },
        signal,
        onStep,
      });
      const file = { ...described, resource: Object.freeze({ ...described.resource, access }) };
      // Named from now on by its drive and item, never by the share link.
      return { title: file.title, file, attribution: file.attribution, locator: ids };
    },
  });
}

export default createOneDriveProvider();
