/**
 * Google Drive files (any single-file input format: an `.h5ad`, a Zarr ZIP,
 * a `.loom`, …), read in place through the Drive API (`files.get?alt=media`
 * with `Range`), the one Google host that lets other sites read a file's
 * bytes. Drive's download pages refuse every
 * cross-site read.
 *
 * - **Shared with anyone who has the link:** read with Cellucid's public API
 *   key, no sign-in. The item and the file's first bytes are asked for
 *   together: it opens one round trip after the paste. A key-only request is
 *   CORS-safelisted, so no read pays a preflight. Google holds back
 *   downloads without a sign-in from a network that made many of them: for a
 *   while it answers them with an HTML "unusual traffic" page (HTTP 403)
 *   without CORS headers, which the page sees only as a failed request,
 *   while the file's details still answer and a request that carries a
 *   sign-in still reaches the API (seen three times on 2026-10-25, each
 *   after some 200-400 MB from one address within minutes, for about 50
 *   minutes). A file whose first bytes are
 *   held back so opens after "[Sign in to Google]" and the file picker, as
 *   a private one. A read held back after the file opened says so as soon
 *   as Google's answers show it (`heldBackNow`: the details answer, one byte
 *   fails), as opening does.
 * - **Signed in, and the file granted to Cellucid:** read with the sign-in,
 *   public or not.
 * - **Signed in, and the file not granted yet** (a `drive.file` sign-in
 *   reads only the files the person chose for Cellucid, so Google answers
 *   any other file, public or not, "not found"): Google's file picker opens
 *   at once, already showing the file; one click on Select grants it and it
 *   is read with the sign-in, which Google never holds back. Nobody signed
 *   in is asked to sign in. Closed without choosing, a public file is read
 *   with the key unless Google holds it back now.
 * - **Private, shared with the person:** "Private file on Google Drive.
 *   [Sign in to Google]". The click signs in (scope `drive.file`, which
 *   grants only the files the person chooses for Cellucid) and Google's file
 *   picker opens already showing the file: one click on Select grants it.
 *   Granted once, it opens straight away next time. Reads carry the token,
 *   which the page renews with one click when it expires (`sources/access.js`).
 *
 * Every read goes through the same byte reader whichever way it is let in:
 * the same ranges, concurrency, caches and, for a file read once (an R
 * object), the same kept copy, named by the file's id and checksum.
 *
 * Accepts `drive.google.com/file/d/<id>/…`, `drive.google.com/open?id=<id>`,
 * `drive.google.com/uc?id=<id>` (also under `/u/<n>/`, as gdown links often
 * are), `docs.google.com/uc?id=<id>`,
 * `drive.usercontent.google.com/download?id=<id>` (any of them with
 * `resourcekey=`), and `gdrive:<id>[~<resource key>]`. Folders are refused:
 * a Zarr store is thousands of files, each its own URL and request; the same
 * store as one `.zarr.zip` reads in place at the same speed.
 *
 * @module data/sources/providers/gdrive
 */

import { DataSourceError, DataSourceErrorCode, explainedFailure } from '../../data-source.js';
import { describeRemoteFile } from '../remote-file.js';
import { requestJson } from '../api-request.js';
import { registerSourceAccess, revokeSourceAccess } from '../access.js';
import { getGoogleAuth } from '../auth/google.js';
import { HEAD_BYTES, headOfFile, isUnanswered, readFileHead } from '../../../formats/io/byte-source.js';
import { openableNamesText } from '../../input-formats.js';

const FILES = 'https://www.googleapis.com/drive/v3/files/';
const FIELDS = 'id,name,size,md5Checksum,mimeType,headRevisionId,capabilities/canDownload';
const ID = /^[A-Za-z0-9_-]{10,}$/;
const RESOURCE_KEY = /^[A-Za-z0-9_-]+$/;
const GOOGLE_APPS = 'application/vnd.google-apps.';

/** `<id>[~<resource key>]`, `folder:<id>`, `document:<id>`, or null. */
export function parseDrive(input, explicit = true) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (explicit) {
    const plain = /^([A-Za-z0-9_-]+)(?:~([A-Za-z0-9_-]+))?$/.exec(text);
    if (plain !== null) return ID.test(plain[1]) ? text : null;
    if (/^(folder|document):[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  let id = null;
  if (host === 'drive.google.com') {
    const folder = /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/.exec(path);
    if (folder !== null) return ID.test(folder[1]) ? `folder:${folder[1]}` : null;
    const file = /^\/(?:u\/\d+\/)?file\/d\/([A-Za-z0-9_-]+)/.exec(path);
    if (file !== null) id = file[1];
    else if (/^\/(?:u\/\d+\/)?(open|uc)\/?$/.test(path)) id = url.searchParams.get('id');
  } else if (host === 'docs.google.com') {
    const document = /^\/(?:document|spreadsheets|presentation|forms|drawings)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(path);
    if (document !== null) return ID.test(document[1]) ? `document:${document[1]}` : null;
    if (/^\/uc\/?$/.test(path)) id = url.searchParams.get('id');
  } else if (host === 'drive.usercontent.google.com') {
    if (/^\/(download|uc)\/?$/.test(path)) id = url.searchParams.get('id');
  } else {
    return null;
  }
  if (id === null || !ID.test(id)) return null;
  const key = url.searchParams.get('resourcekey');
  return key !== null && RESOURCE_KEY.test(key) ? `${id}~${key}` : id;
}

/** What a provider's `open` answers for one file. */
function opened(file) {
  return { title: file.title, file, attribution: file.attribution };
}

/**
 * A refusal written for the person (what is wrong, what to do): shown as it
 * is wherever it arrives (`explainedFailure`).
 */
function refusal(message, code, details = {}) {
  return explainedFailure(message, code, 'link', details);
}

const FOLDER_REFUSAL =
  'This link is a Google Drive folder. Cellucid opens single files from Google Drive: share the file itself ' +
  `(${openableNamesText({ layouts: ['file', 'zip'] })}) and paste its link.`;

/** What a download Google holds back from a page without a sign-in looks like to the page. */
const HELD_BACK =
  'Google Drive is not sending this file to this browser without a Google sign-in for now: Google holds ' +
  'back downloads without a sign-in for a while after many of them from one network (a lost connection ' +
  'looks the same to this page).';

/**
 * Whether Google holds back the file's bytes now (`HELD_BACK`), told by one
 * byte: Google answers a held-back download only after about seven seconds,
 * with a page the browser does not let this one read, so the answer is
 * waited for as long as Google takes (`signal` cancels it). A failed request
 * means held back.
 */
async function oneByteFails(media, headers, signal) {
  try {
    const response = await globalThis.fetch(media, { headers: { ...headers, Range: 'bytes=0-0' }, cache: 'no-store', signal });
    await response.body?.cancel().catch(() => {});
    return false;
  } catch (error) {
    if (signal?.aborted) throw error;
    return true;
  }
}

/**
 * Whether the first bytes of a file whose details answered are held back:
 * the head read stalls first, or fails with no answer (`isUnanswered`), and
 * one byte confirms it (`oneByteFails`).
 */
async function heldBack(headRead, media, headers, signal) {
  if (headRead === null) return false;
  try {
    await headRead;
    return false;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!isUnanswered(error)) return false;
  }
  return oneByteFails(media, headers, signal);
}

/** The reason a Drive API error names (`userRateLimitExceeded`, `notFound`, …), or null. */
function reasonOf(body) {
  return body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null;
}

/** Drive answers its rate limits with 403: those are asked again. */
function transientDriveAnswer(status, body) {
  return status === 403 && ['userRateLimitExceeded', 'rateLimitExceeded'].includes(reasonOf(body));
}

/** An answer that only says the file is private, or not granted to Cellucid. */
function isPrivateAnswer(answer) {
  if (answer.status === 404) return true;
  if (answer.status !== 403) return false;
  return !['downloadQuotaExceeded', 'cannotDownloadAbusiveFile', 'dailyLimitExceeded'].includes(reasonOf(answer.body));
}

/** The refusal of a Drive answer that is neither the file nor "private". */
function driveFailure(answer, id) {
  const reason = reasonOf(answer.body);
  if (reason === 'downloadQuotaExceeded') {
    return refusal(
      'Google has limited downloads of this file for now. Try again later, or ask its owner to share a copy.',
      DataSourceErrorCode.NETWORK_ERROR,
      { id, reason }
    );
  }
  if (reason === 'cannotDownloadAbusiveFile') {
    return refusal(
      'Google has flagged this file, and only its owner can download it.',
      DataSourceErrorCode.PERMISSION_DENIED,
      { id, reason }
    );
  }
  if (answer.status === 400 && /key/i.test(String(reason ?? answer.body?.error?.message ?? ''))) {
    return refusal(
      'Google Drive is not configured correctly on this site: Google refused its API key.',
      DataSourceErrorCode.UNSUPPORTED,
      { id, reason }
    );
  }
  return new DataSourceError(
    `Google Drive could not read the file (HTTP ${answer.status}${reason ? `, ${reason}` : ''}).`,
    DataSourceErrorCode.NETWORK_ERROR,
    'link',
    { id, status: answer.status, reason }
  );
}

/**
 * The Drive provider, given its Google sign-in (`auth/google.js`).
 *
 * @param {{google?: ReturnType<import('../auth/google.js').createGoogleAuth>}} [options]
 */
export function createDriveProvider({ google = null } = {}) {
  const auth = () => google ?? getGoogleAuth();

  /** Headers every request of one file carries: its resource key, when its link had one. */
  function keyHeaders(id, resourceKey) {
    return resourceKey === null ? {} : { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` };
  }

  function urls(id, signedIn) {
    const key = signedIn ? '' : `&key=${encodeURIComponent(auth().apiKey)}`;
    return {
      metadata: `${FILES}${encodeURIComponent(id)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true${key}`,
      media: `${FILES}${encodeURIComponent(id)}?alt=media&supportsAllDrives=true${key}`,
    };
  }

  function headersOf(id, resourceKey, token) {
    return {
      ...keyHeaders(id, resourceKey),
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    };
  }

  /**
   * The file's first bytes, asked once: a failure is told apart by the
   * caller (`heldBack`), not repeated. `token` null: with the API key.
   */
  function readHead(id, resourceKey, token, signal) {
    const headers = headersOf(id, resourceKey, token);
    const head = readFileHead(urls(id, token !== null).media, HEAD_BYTES, {
      signal,
      once: true,
      fetchImpl: (url, init) => globalThis.fetch(url, { ...init, headers: { ...init.headers, ...headers } }),
    });
    head.catch(() => {});
    return head;
  }

  /**
   * The item and, beside it, the file's first bytes: `{answer, head}`.
   * `token` null: with the API key (no preflight).
   */
  function ask(id, resourceKey, token, signal, { withHead = true } = {}) {
    const early = new AbortController();
    const earlySignal = signal === null ? early.signal : AbortSignal.any([signal, early.signal]);
    const head = withHead ? readHead(id, resourceKey, token, earlySignal) : null;
    const answer = requestJson(urls(id, token !== null).metadata, {
      label: 'Google Drive',
      headers: headersOf(id, resourceKey, token),
      signal,
      transient: transientDriveAnswer,
    });
    return { answer, head, stop: reason => early.abort(reason) };
  }

  /** The file's entry from a Drive item that answered. */
  async function describe(id, resourceKey, item, headRead, access, signal, onStep) {
    if (item.mimeType === `${GOOGLE_APPS}folder`) {
      throw refusal(FOLDER_REFUSAL, DataSourceErrorCode.UNSUPPORTED, { id });
    }
    if (typeof item.mimeType === 'string' && item.mimeType.startsWith(GOOGLE_APPS)) {
      throw refusal(
        `${item.name ?? 'This file'} is a Google document, not a file Cellucid opens. Share ` +
        `${openableNamesText({ layouts: ['file', 'zip'] })} and paste its link.`,
        DataSourceErrorCode.UNSUPPORTED,
        { id, mimeType: item.mimeType }
      );
    }
    if (item.capabilities?.canDownload === false) {
      throw refusal(
        `The owner of ${item.name ?? 'this file'} has turned off downloading for it, so it cannot be read.`,
        DataSourceErrorCode.PERMISSION_DENIED,
        { id }
      );
    }
    const size = Number(item.size);
    let head = null;
    if (headRead !== null && Number.isSafeInteger(size)) {
      try {
        head = headOfFile(await headRead, size, HEAD_BYTES);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    const file = await describeRemoteFile({
      // The display link: what the Transfers log and messages name. Reads
      // go to the access target (with the key, or the token).
      url: `${FILES}${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      id: `gdrive:${id}`,
      name: String(item.name ?? ''),
      size: Number.isSafeInteger(size) ? size : null,
      head,
      // A validator only where Drive states one (a checksum, a revision):
      // without one the file is known by its size alone (`remote-file.js`).
      version: typeof item.md5Checksum === 'string' && item.md5Checksum !== ''
        ? `md5:${item.md5Checksum}:${size}`
        : typeof item.headRevisionId === 'string' && item.headRevisionId !== '' ? `revision:${item.headRevisionId}:${size}` : null,
      attribution: { title: String(item.name ?? id), url: `https://drive.google.com/file/d/${id}/view` },
      signal,
      onStep,
    });
    return { ...file, resource: Object.freeze({ ...file.resource, access }) };
  }

  /**
   * Whether Google holds back a public file's bytes now, from Google's own
   * answers: the file's details answer while one byte of it fails
   * (`oneByteFails`). Details that fail too are a lost connection, not a
   * hold. Either answer that rules the hold out settles it at once.
   */
  function heldBackNow(id, resourceKey) {
    const { metadata, media } = urls(id, false);
    const headers = keyHeaders(id, resourceKey);
    const settled = new AbortController();
    const details = requestJson(metadata, {
      label: 'Google Drive',
      headers,
      signal: settled.signal,
      transient: transientDriveAnswer,
    }).then(answer => answer.ok, () => false);
    const bytes = oneByteFails(media, headers, settled.signal).catch(() => false);
    return new Promise(resolve => {
      let held = 0;
      const told = yes => {
        if (!yes) {
          resolve(false);
          settled.abort(new DOMException('Google answered: not held back.', 'AbortError'));
        } else if (++held === 2) {
          resolve(true);
        }
      };
      details.then(told);
      bytes.then(told);
    });
  }

  /** The reads of a public file: the API key, no sign-in. */
  function publicAccess(id, resourceKey) {
    const { media } = urls(id, false);
    return registerSourceAccess({
      provider: 'gdrive',
      target: async () => ({ url: media, headers: keyHeaders(id, resourceKey) }),
      unreadable: {
        // Opened again, the file is read with the person's Google account,
        // which Google lets through: after a sign-in, or straight from the
        // picker when signed in already.
        text: `${HELD_BACK} Open the file again to read it with your Google account, or try again in a few minutes.`,
        confirm: () => heldBackNow(id, resourceKey),
      },
    });
  }

  /**
   * The reads of a file opened signed in: the token, renewed with one click
   * when it expires. A read carrying the token is preflighted; each request
   * in flight goes to its own stable URL (`lane`, a query parameter Drive
   * ignores: `byte-source.js`), so the browser keeps every lane's preflight
   * instead of asking one per request. Drive's downloads are never reusable
   * from a cache (`private, max-age=0, must-revalidate`, no validators).
   */
  function signedAccess(id, resourceKey) {
    const { media } = urls(id, true);
    let given = null;
    return registerSourceAccess({
      provider: 'gdrive',
      target: async ({ refresh }) => {
        const google = auth();
        if (refresh && given !== null) google.refused(given);
        given = google.validToken() ?? await google.authorize({
          kind: 'expired',
          text: 'Google sign-in expired. Reading this file goes on once you sign in again.',
        });
        return { url: media, headers: { ...keyHeaders(id, resourceKey), Authorization: `Bearer ${given}` }, lane: 'lane' };
      },
    });
  }

  /**
   * Open a file signed in: granted already, or granted now in Google's file
   * picker.
   *
   * @param {{text: string, notGrantedTo?: string|null, readPublic?: (() => Promise<Object|null>)|null}} reasons
   *   `text`: why a sign-in is asked for, when nobody is signed in;
   *   `notGrantedTo`: the token Google just answered "not found" for this
   *   file (not granted to Cellucid yet), so with it the picker opens at once;
   *   `readPublic()`: the file is public, and read with the key when the
   *   picker is closed without choosing it (null when Google holds it back
   *   now)
   */
  async function openSignedIn(id, resourceKey, signal, onStep, { text, notGrantedTo = null, readPublic = null }) {
    const google = auth();
    let token = google.validToken();
    if (token === null) {
      onStep?.('Waiting for you to sign in to Google');
      token = await google.authorize({ kind: 'sign-in', text, signal });
    }
    let picked = false;
    let granted = token !== notGrantedTo;
    for (;;) {
      if (granted) {
        onStep?.('Reading the file\'s details on Google Drive');
        const request = ask(id, resourceKey, token, signal);
        const answer = await request.answer;
        if (answer.ok) {
          return describe(id, resourceKey, answer.body ?? {}, request.head, signedAccess(id, resourceKey), signal, onStep);
        }
        request.stop(new DOMException('The file is not readable yet.', 'AbortError'));
        if (answer.status === 401) {
          google.refused(token);
          onStep?.('Waiting for you to sign in to Google again');
          token = await google.authorize({ kind: 'expired', text: 'Google sign-in expired.', signal });
          continue;
        }
        if (!isPrivateAnswer(answer)) throw driveFailure(answer, id);
        if (picked) {
          throw refusal(
            'Your Google account cannot open this file: it was not shared with you, or the link is wrong. ' +
            'Ask its owner to share it with your Google account.',
            DataSourceErrorCode.PERMISSION_DENIED,
            { id }
          );
        }
      }
      granted = true;
      // Not granted to Cellucid yet: Google's picker, already on this file.
      onStep?.('Choose the file in Google\'s file picker (Select) to let Cellucid read it');
      let chosen;
      try {
        chosen = await google.pick(id, { signal });
      } catch (error) {
        if (signal?.aborted || readPublic === null || error?.code !== 'NOT_PICKED') throw error;
        // Closed without choosing it: a public file is read with the key,
        // unless Google holds its downloads back now.
        onStep?.('Reading the file\'s details on Google Drive');
        const file = await readPublic();
        if (file !== null) return file;
        throw refusal(
          `${HELD_BACK} Choose the file in Google's file picker to read it with your Google account, or try ` +
          'again in a few minutes.',
          DataSourceErrorCode.NETWORK_ERROR,
          { id }
        );
      }
      picked = true;
      if (chosen !== id) {
        throw refusal(
          'A different file was chosen in Google\'s file picker. Choose the file the link names.',
          DataSourceErrorCode.VALIDATION_ERROR,
          { id }
        );
      }
    }
  }

  async function signIn() {
    return auth().authorize({ kind: 'sign-in' });
  }

  function signOut() {
    auth().signOut();
    revokeSourceAccess('gdrive');
  }

  return Object.freeze({
    id: 'gdrive',
    label: 'Google Drive',
    capabilities: Object.freeze({
      folders: false,
      private: 'sign-in',
      versions: false,
      write: false,
    }),
    auth: Object.freeze({
      signIn,
      signOut,
      authorize: () => auth().validToken(),
    }),
    match(input, { explicit = true } = {}) {
      return parseDrive(input, explicit);
    },
    async open(value, { signal = null, onStep = null } = {}) {
      const parsed = parseDrive(value);
      if (parsed === null) {
        throw refusal(`"${value}" is not a Google Drive file link.`, DataSourceErrorCode.INVALID_FORMAT, { input: value });
      }
      if (parsed.startsWith('folder:')) throw refusal(FOLDER_REFUSAL, DataSourceErrorCode.UNSUPPORTED, { input: value });
      if (parsed.startsWith('document:')) {
        throw refusal(
          `This link is a Google document, not a file Cellucid opens. Share ${openableNamesText({ layouts: ['file', 'zip'] })} and paste its link.`,
          DataSourceErrorCode.UNSUPPORTED,
          { input: value }
        );
      }
      const [id, resourceKey = null] = parsed.split('~');
      const google = auth();
      const notConfigured = google.whyNoPublicAccess();
      if (notConfigured !== null) throw refusal(notConfigured, DataSourceErrorCode.UNSUPPORTED, { input: value });
      // Shared with anyone: the key alone reads it. When a sign-in is held,
      // the signed-in item is asked for beside it (a granted file then opens
      // in the same round trips); the head is read once, signed in when that
      // is possible, since its bytes are the same either way.
      const token = google.validToken();
      const open = ask(id, resourceKey, null, signal, { withHead: token === null });
      const signed = token === null ? null : ask(id, resourceKey, token, signal);
      signed?.answer.catch(() => {});
      const answer = await open.answer.catch(error => {
        signed?.stop(error);
        throw error;
      });
      if (!answer.ok) {
        open.stop(new DOMException('The file is not public.', 'AbortError'));
        if (!isPrivateAnswer(answer)) {
          signed?.stop(new DOMException('The file cannot be read.', 'AbortError'));
          throw driveFailure(answer, id);
        }
      }
      // Granted to Cellucid: read with the sign-in, which Google lets
      // through where it holds back downloads without one.
      let notGrantedTo = null;
      if (signed !== null) {
        // A sign-in that fails here is asked for again below, when it is needed.
        const signedAnswer = await signed.answer.catch(() => null);
        if (signedAnswer?.ok === true) {
          return opened(await describe(id, resourceKey, signedAnswer.body ?? {}, signed.head, signedAccess(id, resourceKey), signal, onStep));
        }
        signed.stop(new DOMException('The file is not granted yet.', 'AbortError'));
        if (signedAnswer?.status === 401) google.refused(token);
        else if (signedAnswer !== null && isPrivateAnswer(signedAnswer)) notGrantedTo = token;
      }
      /** A public file read with the key, or null when Google holds its downloads back now. */
      let readPublic = !answer.ok ? null : async () => {
        // Its head was read beside the item only when nobody was signed in.
        const head = open.head ?? readHead(id, resourceKey, null, signal);
        if (await heldBack(head, urls(id, false).media, keyHeaders(id, resourceKey), signal)) return null;
        return describe(id, resourceKey, answer.body ?? {}, head, publicAccess(id, resourceKey), signal, onStep);
      };
      if (readPublic !== null && google.validToken() === null) {
        const file = await readPublic();
        if (file !== null) return opened(file);
        // Held back now: asking again after the picker would only repeat it.
        readPublic = null;
      }
      const noSignIn = google.whyNoSignIn();
      if (noSignIn !== null) {
        throw answer.ok
          ? refusal(
            `${HELD_BACK} Try again in a few minutes, or download the file from Google Drive and open it with ` +
            `Open… › File…. ${noSignIn}`,
            DataSourceErrorCode.NETWORK_ERROR,
            { input: value }
          )
          : refusal(
            `This file is private on Google Drive, or the link is wrong. ${noSignIn}`,
            DataSourceErrorCode.PERMISSION_DENIED,
            { input: value }
          );
      }
      // Google's scripts load while the person reads the step.
      google.loadScripts().catch(() => {});
      return opened(await openSignedIn(id, resourceKey, signal, onStep, {
        text: answer.ok ? 'Google Drive sends this file only with a Google sign-in for now.' : 'Private file on Google Drive.',
        notGrantedTo,
        readPublic,
      }));
    },
  });
}

export default createDriveProvider();
