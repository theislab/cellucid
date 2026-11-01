/**
 * The data-source providers and the `?data=` locators that name them.
 *
 * A provider knows where bytes live; it never parses a data format. Each one
 * is a module under `providers/` with the same contract:
 *
 * ```js
 * {
 *   id,             // the locator scheme: `<id>:<value>` (the `url` provider
 *                   // writes its value bare, since it is already a URL)
 *   label,          // what the user reads
 *   capabilities,   // {folders, private: 'none'|'link'|'sign-in', public, versions, write}
 *                   //   `public`: every file it serves is public (a 401/403
 *                   //   is its host refusing this network, `providerFault`)
 *   match(input, {explicit}),
 *                   // pasted text, a short form, or its own canonical value
 *                   //   → canonical value, or null when it is not this provider's;
 *                   //   `explicit` is true after the provider's own scheme
 *                   //   (`hf:…`), so ambiguous short forms (a bare number,
 *                   //   `user/repo`) are claimed only then
 *   async open(value, {signal, onStep}),
 *                   // → {title, attribution, catalog: {baseUrl}} for a dataset
 *                   //   catalog folder, {title, attribution, file} for
 *                   //   one dataset file (see `remote-file.js`),
 *                   //   {title, attribution, store: {url, name, title, id,
 *                   //   attribution}} for one Zarr store folder, or
 *                   //   {title, attribution, files} for files that make one
 *                   //   dataset together (`describeRemoteFileSet`), and
 *                   //   `locator` when what opened has a canonical value
 *                   //   of its own (a OneDrive share link opens as its
 *                   //   drive and item); `onStep(text)`
 *                   //   says what it is doing (`Listing the files of GSE…`),
 *                   //   shown by the opening progress; it makes as few
 *                   //   dependent round trips as the host allows
 *   publicValue(value),
 *                   // a value without what grants access to it (a share
 *                   //   key, a signature, a share link that is itself the
 *                   //   key): what sessions, Share links, figures,
 *                   //   notifications, the opening's title and the console
 *                   //   are given from the moment the value is known
 *                   //   (`link-credentials.js`). Every provider states it,
 *                   //   the value itself when none of its values carries
 *                   //   access: no provider's value is shown by default
 *   auth?,          // {signIn, signOut, authorize(request)} for a provider
 *                   //   that reads behind a sign-in; tokens never leave it
 *                   //   but through `sources/access.js` to the reader
 * }
 * ```
 *
 * A resolved link has two forms: its `locator`, the read target (what was
 * pasted, canonical), held in memory and in the page address only, and its
 * `publicLocator`, which every other place is given.
 *
 * Adding a source is one module plus one line in `DEFAULT_PROVIDERS`;
 * removing it deletes both. Nothing else in the app names a provider.
 *
 * @module data/sources/registry
 */

import { DataSourceError, DataSourceErrorCode } from '../data-source.js';
import cellxgene from './providers/cellxgene.js';
import dropbox from './providers/dropbox.js';
import figshare from './providers/figshare.js';
import gdrive from './providers/gdrive.js';
import geo from './providers/geo.js';
import github from './providers/github.js';
import http from './providers/http.js';
import huggingface from './providers/huggingface.js';
import onedrive from './providers/onedrive.js';
import zenodo from './providers/zenodo.js';
import { openableNamesText } from '../input-formats.js';
import { publicLink } from './link-credentials.js';

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const PRIVATE_MODES = new Set(['none', 'link', 'sign-in']);

/**
 * Check one provider against the contract.
 *
 * @param {unknown} provider
 * @returns {Object}
 */
export function requireProvider(provider) {
  const fail = reason => {
    throw new TypeError(`Data source provider ${String(provider?.id)}: ${reason}.`);
  };
  if (provider === null || typeof provider !== 'object') fail('must be an object');
  if (typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id)) {
    fail('id must be a lower-case scheme name');
  }
  if (typeof provider.label !== 'string' || provider.label.trim() === '') {
    fail('needs a label');
  }
  if (typeof provider.match !== 'function') fail('needs match(input)');
  if (typeof provider.open !== 'function') fail('needs open(value, options)');
  if (typeof provider.publicValue !== 'function') {
    fail('needs publicValue(value): what may be shown of a value (itself when none carries access)');
  }
  const capabilities = provider.capabilities;
  if (
    capabilities === null ||
    typeof capabilities !== 'object' ||
    typeof capabilities.folders !== 'boolean' ||
    !PRIVATE_MODES.has(capabilities.private) ||
    typeof capabilities.public !== 'boolean' ||
    typeof capabilities.versions !== 'boolean' ||
    typeof capabilities.write !== 'boolean'
  ) {
    fail('capabilities must state folders, private, public, versions and write');
  }
  if (capabilities.private === 'sign-in') {
    const auth = provider.auth;
    if (
      auth === null ||
      typeof auth !== 'object' ||
      typeof auth.signIn !== 'function' ||
      typeof auth.signOut !== 'function' ||
      typeof auth.authorize !== 'function'
    ) {
      fail('a sign-in provider needs auth.signIn, auth.signOut and auth.authorize');
    }
  }
  return provider;
}

/**
 * Providers in match order: specific hosts and short forms first, any web
 * address last.
 */
export const DEFAULT_PROVIDERS = Object.freeze([
  cellxgene,
  geo,
  zenodo,
  figshare,
  huggingface,
  gdrive,
  onedrive,
  dropbox,
  github,
  http,
]);

export class ProviderRegistry {
  /**
   * @param {Object[]} [providers]
   */
  constructor(providers = DEFAULT_PROVIDERS) {
    /** @type {Map<string, Object>} */
    this._providers = new Map();
    for (const provider of providers) this.register(provider);
  }

  /** @param {Object} provider */
  register(provider) {
    requireProvider(provider);
    if (this._providers.has(provider.id)) {
      throw new TypeError(`Data source provider '${provider.id}' is already registered.`);
    }
    this._providers.set(provider.id, provider);
  }

  /** @returns {Object[]} */
  list() {
    return [...this._providers.values()];
  }

  /**
   * @param {string} id
   * @returns {Object|null}
   */
  get(id) {
    return this._providers.get(id) ?? null;
  }

  /**
   * Pasted text or a `?data=` value as it may be shown or kept: the public
   * locator of the link it resolves to, or the text's public form
   * (`publicLink`) when it names no source.
   *
   * @param {unknown} input
   * @returns {string}
   */
  publicFormOf(input) {
    const text = String(input).trim();
    try {
      return this.resolve(text).publicLocator;
    } catch {
      return publicLink(text);
    }
  }

  /**
   * Resolve pasted text or a `?data=` value to one provider and its
   * canonical locator.
   *
   * @param {string} input
   * @returns {{provider: Object, value: string, locator: string, publicLocator: string}}
   */
  resolve(input) {
    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new DataSourceError(
        'Paste a link or an id to open.',
        DataSourceErrorCode.INVALID_FORMAT,
        'link'
      );
    }
    const text = input.trim();
    const scheme = /^([a-z][a-z0-9-]*):(?!\/\/)(.+)$/s.exec(text);
    if (scheme !== null && this._providers.has(scheme[1])) {
      const provider = this._providers.get(scheme[1]);
      const value = provider.match(scheme[2], { explicit: true });
      if (value === null) {
        throw new DataSourceError(
          `"${publicLink(scheme[2])}" is not a valid ${provider.label} reference.`,
          DataSourceErrorCode.INVALID_FORMAT,
          'link',
          { input: publicLink(text) }
        );
      }
      return resolved(provider, value);
    }
    for (const provider of this._providers.values()) {
      const value = provider.match(text, { explicit: false });
      if (value !== null) return resolved(provider, value);
    }
    throw new DataSourceError(
      `Cellucid does not recognise "${publicLink(text)}". Paste a web address (${openableNamesText({ layouts: ['file', 'zip'] })}, ` +
      'a Zarr store folder, or a folder holding ' +
      'datasets.json ending in "/"), a GitHub repository (owner/repo/path), a Hugging Face dataset ' +
      '(hf:user/repo), a Zenodo record or DOI, a Figshare item or DOI, a Google Drive, OneDrive or ' +
      'Dropbox file link, a CELLxGENE dataset link or id, or a GEO series or sample (GSE…, GSM…).',
      DataSourceErrorCode.INVALID_FORMAT,
      'link',
      { input: publicLink(text) }
    );
  }
}

function resolved(provider, value) {
  return Object.freeze({
    provider,
    value,
    locator: formatLocator(provider, value),
    publicLocator: publicLocatorOf(provider, value),
  });
}

/**
 * The public form of one provider value as a locator: without the share
 * key, signature or token the value may carry.
 *
 * @param {Object} provider
 * @param {string} value
 * @returns {string}
 */
export function publicLocatorOf(provider, value) {
  return formatLocator(provider, provider.publicValue(value));
}

/**
 * The `?data=` form of one provider value.
 *
 * @param {Object} provider
 * @param {string} value
 * @returns {string}
 */
export function formatLocator(provider, value) {
  return provider.id === 'url' ? value : `${provider.id}:${value}`;
}

/**
 * A page address with its data link (`?data=`) in public form
 * (`publicFormOf`), for whatever reports where the page is: the address is
 * the one place a link keeps its access key.
 *
 * @param {string} href
 * @returns {string}
 */
export function publicPageAddress(href) {
  const url = new URL(href);
  const link = url.searchParams.get('data');
  if (link !== null) url.searchParams.set('data', getProviderRegistry().publicFormOf(link));
  return url.href;
}

let defaultRegistry = null;

/** @returns {ProviderRegistry} */
export function getProviderRegistry() {
  defaultRegistry ??= new ProviderRegistry();
  return defaultRegistry;
}
