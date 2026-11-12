/**
 * CELLxGENE Discover datasets, read from the per-dataset `.h5ad` copies that
 * CZ CELLxGENE Census publishes in its public S3 bucket. Discover's own API
 * and file host allow only CELLxGENE's site to read them from a browser; the
 * Census bucket allows any site. So a dataset opens at the version in the
 * latest Census release, and a dataset published after that release cannot
 * be opened from a link (the error says so and what to do instead).
 *
 * Accepts a dataset id (a UUID), a Discover Explorer link
 * (`cellxgene.cziscience.com/e/<dataset_id>.cxg/`), or `cellxgene:<id>`;
 * and a Census copy's own address (`s3://cellxgene-census-public-us-west-2/
 * cell-census/<build>/h5ads/<id>.h5ad`, as the Census documentation hands
 * it out, or any HTTPS address of it), opened as `cellxgene:census/<build>/
 * <id>`: the same bytes by either route are one dataset (`cellxgene:<id>`,
 * version `census:<build>`), so its sessions, annotations and what this
 * browser keeps of it carry over.
 *
 * Opening costs two dependent round trips, the release list and then the
 * file's probe, and usually one: the release this browser read last is
 * remembered (`localStorage`), and the file is probed in it at the same time
 * as the release list is read. When the list names the same release, the
 * probe already answered; when a newer release came out, the file is probed
 * again in it, so a link always opens the release the list names.
 *
 * @module data/sources/providers/cellxgene
 */

import { DataSourceError, DataSourceErrorCode, fetchWhenNotBusy, hostFaultFailure, hostFaultOfResponse } from '../../data-source.js';
import { describeRemoteFile } from '../remote-file.js';
import { fileFormatOfName, titleOfName } from '../../input-formats.js';
import { cancel } from '../../../utils/abort.js';
import { webStorage } from '../../../utils/web-storage.js';

export const CENSUS_BUCKET_URL =
  'https://cellxgene-census-public-us-west-2.s3.us-west-2.amazonaws.com';

/** Where the release this browser read last is remembered. */
const RELEASE_MEMORY_KEY = 'cellucid:cellxgene-census-release';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Census bucket's name, which every address of a copy names (`CENSUS_BUCKET_URL`). */
const CENSUS_BUCKET = 'cellxgene-census-public-us-west-2';

/** A copy's key in the bucket: `cell-census/<build>/h5ads/<file>`, the file `<id>.h5ad`. */
const CENSUS_COPY = /^\/?cell-census\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/h5ads\/([^/]+)$/;

/**
 * `census/<build>/<id>` for an address of a Census copy: `s3://<bucket>/<key>`,
 * the bucket's virtual-hosted address on any S3 endpoint, or a path-style
 * one; else null.
 */
function censusCopyOf(text) {
  let bucket;
  let key;
  const uri = /^s3:\/\/([^/]+)(\/.*)$/i.exec(text);
  if (uri !== null) {
    [, bucket, key] = uri;
  } else {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.search !== '') return null;
    const host = url.hostname.toLowerCase();
    if (!/(^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(host)) return null;
    if (host.startsWith(`${CENSUS_BUCKET}.`)) {
      bucket = CENSUS_BUCKET;
      key = url.pathname;
    } else {
      const parts = url.pathname.split('/');
      bucket = parts[1];
      key = `/${parts.slice(2).join('/')}`;
    }
  }
  const copy = bucket === CENSUS_BUCKET ? CENSUS_COPY.exec(key.toLowerCase()) : null;
  if (copy === null || fileFormatOfName(copy[2])?.format !== 'h5ad') return null;
  const id = titleOfName(copy[2]);
  return UUID.test(id) ? `census/${copy[1]}/${id}` : null;
}

function refuse(message, details) {
  return new DataSourceError(message, DataSourceErrorCode.UNSUPPORTED, 'link', details);
}

/**
 * Parse an input into a dataset id, `collection/<id>` or `version/<id>`,
 * or null when it is not a CELLxGENE reference.
 */
function parseCellxgene(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const lower = text.toLowerCase();
  if (UUID.test(lower)) return lower;
  const named = /^census\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/([0-9a-f-]{36})$/.exec(lower);
  if (named !== null && UUID.test(named[2])) return lower;
  const copy = censusCopyOf(text);
  if (copy !== null) return copy;
  const prefixed = /^(collection|version)\/([0-9a-f-]{36})$/.exec(lower);
  if (prefixed !== null && UUID.test(prefixed[2])) return lower;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === 'cellxgene.cziscience.com') {
    const explorer = /^\/e\/([0-9a-f-]{36})\.cxg\/?$/.exec(path);
    if (explorer !== null && UUID.test(explorer[1])) return explorer[1];
    const collection = /^\/collections\/([0-9a-f-]{36})\/?$/.exec(path);
    if (collection !== null && UUID.test(collection[1])) return `collection/${collection[1]}`;
    return null;
  }
  if (host === 'datasets.cellxgene.cziscience.com') {
    const download = /^\/([0-9a-f-]{36})\.(h5ad|rds)$/.exec(path);
    if (download !== null && UUID.test(download[1])) return `version/${download[1]}`;
  }
  return null;
}

/**
 * The Census release a link reads: `latest` in `release.json`, followed
 * through aliases to the build whose `h5ads` folder holds the copies.
 */
async function latestCensusRelease(signal) {
  const response = await fetchWhenNotBusy(`${CENSUS_BUCKET_URL}/cell-census/release.json`, {
    signal,
    cache: 'no-cache',
  });
  if (!response.ok) {
    const fault = hostFaultOfResponse(response, 'the Census release list', { url: `${CENSUS_BUCKET_URL}/cell-census/release.json` });
    if (fault !== null) throw fault;
    // The list is public to everyone: a 401 or 403 is its host refusing this network for now.
    if (response.status === 401 || response.status === 403) {
      throw hostFaultFailure({ kind: 'refusing', host: new URL(CENSUS_BUCKET_URL).host, status: response.status, what: 'the Census release list', service: 'CELLxGENE' },
        { url: `${CENSUS_BUCKET_URL}/cell-census/release.json` });
    }
    throw new DataSourceError(
      `The CELLxGENE Census release list could not be read (HTTP ${response.status}).`,
      DataSourceErrorCode.NETWORK_ERROR,
      'link'
    );
  }
  const releases = await response.json();
  let entry = releases?.latest;
  for (let hops = 0; typeof entry === 'string' && hops < 8; hops++) {
    entry = releases[entry];
  }
  const relative = entry?.h5ads?.relative_uri;
  const build = entry?.release_build;
  if (typeof relative !== 'string' || !relative.startsWith('/') || typeof build !== 'string') {
    throw new DataSourceError(
      'The CELLxGENE Census release list has no current h5ad release.',
      DataSourceErrorCode.INVALID_FORMAT,
      'link'
    );
  }
  return { build, h5adsUrl: `${CENSUS_BUCKET_URL}${relative.endsWith('/') ? relative : `${relative}/`}` };
}

/** The release this browser read last, or null. */
function rememberedRelease() {
  try {
    const release = JSON.parse(webStorage('localStorage')?.getItem(RELEASE_MEMORY_KEY) ?? 'null');
    return typeof release?.build === 'string' &&
      typeof release?.h5adsUrl === 'string' &&
      release.h5adsUrl.startsWith(`${CENSUS_BUCKET_URL}/`)
      ? { build: release.build, h5adsUrl: release.h5adsUrl }
      : null;
  } catch {
    return null;
  }
}

function rememberRelease(release) {
  try {
    webStorage('localStorage')?.setItem(RELEASE_MEMORY_KEY, JSON.stringify(release));
  } catch {
    // Storage may be unavailable (a private window): the next link reads
    // the release list first.
  }
}

export default Object.freeze({
  id: 'cellxgene',
  label: 'CELLxGENE',
  capabilities: Object.freeze({
    folders: false,
    private: 'none',
    public: true,
    versions: false,
    write: false,
  }),
  match(input) {
    return parseCellxgene(input);
  },
  /** A value carries nothing that grants access: it is shown as it is. */
  publicValue(value) {
    return value;
  },
  async open(value, { signal = null, onStep = null } = {}) {
    const parsed = parseCellxgene(value);
    if (parsed === null) {
      throw new DataSourceError(
        `"${value}" is not a CELLxGENE dataset id or link.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { input: value }
      );
    }
    if (parsed.startsWith('census/')) {
      // A copy named by its build: those bytes, under the dataset's identity.
      const [, build, id] = parsed.split('/');
      onStep?.(`Checking the dataset in Census ${build}`);
      const file = await describeRemoteFile({
        url: `${CENSUS_BUCKET_URL}/cell-census/${build}/h5ads/${id}.h5ad`,
        id: `cellxgene:${id}`,
        name: `${id}.h5ad`,
        title: `CELLxGENE ${id}`,
        version: `census:${build}`,
        attribution: {
          title: `CELLxGENE Discover dataset ${id}`,
          url: `https://cellxgene.cziscience.com/e/${id}.cxg/`,
          licence: 'CC BY 4.0',
          via: `CZ CELLxGENE Census ${build}`,
        },
        signal,
      });
      return { title: `CELLxGENE ${id}`, file, attribution: file.attribution };
    }
    const [kind, id] = parsed.includes('/') ? parsed.split('/') : ['dataset', parsed];
    if (kind === 'collection') {
      throw refuse(
        'A CELLxGENE collection holds several datasets, and its list can only ' +
        'be read by CELLxGENE\'s own site. Open the collection, choose a ' +
        'dataset, and paste that dataset\'s "Explore" link.',
        { collection: id }
      );
    }
    if (kind === 'version') {
      throw refuse(
        'This is a download link for one version of a CELLxGENE dataset, ' +
        'which only CELLxGENE\'s own site can read. Paste the dataset\'s ' +
        '"Explore" link (cellxgene.cziscience.com/e/<dataset id>.cxg/) instead.',
        { version: id }
      );
    }
    const explorerUrl = `https://cellxgene.cziscience.com/e/${id}.cxg/`;
    const describeIn = (release, probeSignal) => describeRemoteFile({
      url: `${release.h5adsUrl}${id}.h5ad`,
      id: `cellxgene:${id}`,
      name: `${id}.h5ad`,
      title: `CELLxGENE ${id}`,
      version: `census:${release.build}`,
      attribution: {
        title: `CELLxGENE Discover dataset ${id}`,
        url: explorerUrl,
        licence: 'CC BY 4.0',
        via: `CZ CELLxGENE Census ${release.build}`,
      },
      signal: probeSignal,
    });
    onStep?.('Finding the dataset in the CELLxGENE Census');
    // The file in the release read last is probed beside the release list.
    const remembered = rememberedRelease();
    const early = new AbortController();
    const earlySignal = signal === null ? early.signal : AbortSignal.any([signal, early.signal]);
    const speculative = remembered === null ? null : describeIn(remembered, earlySignal);
    speculative?.catch(() => {});
    let release;
    try {
      release = await latestCensusRelease(signal);
    } catch (error) {
      early.abort(error);
      throw error;
    }
    rememberRelease(release);
    const same = remembered !== null &&
      remembered.build === release.build &&
      remembered.h5adsUrl === release.h5adsUrl;
    let probe = speculative;
    if (!same) {
      cancel(early, 'superseded', 'A newer Census release is read instead.');
      onStep?.(`Checking the dataset in Census ${release.build}`);
      probe = describeIn(release, signal);
    }
    try {
      const file = await probe;
      return { title: `CELLxGENE ${id}`, file, attribution: file.attribution };
    } catch (error) {
      if (error?.code === DataSourceErrorCode.NOT_FOUND) {
        throw new DataSourceError(
          `CELLxGENE dataset ${id} is not in the Census release ` +
          `${release.build}, the only copy a browser may read. It was ` +
          'published or updated after that release, or it is not part of the ' +
          'Census. Download its .h5ad from CELLxGENE and open the file in ' +
          'Cellucid instead.',
          DataSourceErrorCode.NOT_FOUND,
          'link',
          { dataset: id, release: release.build }
        );
      }
      throw error;
    }
  },
});
