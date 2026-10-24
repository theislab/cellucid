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
 *   capabilities,   // {folders, private: 'none'|'link'|'sign-in', versions, write}
 *   match(input, {explicit}),
 *                   // pasted text, a short form, or its own canonical value
 *                   //   → canonical value, or null when it is not this provider's;
 *                   //   `explicit` is true after the provider's own scheme
 *                   //   (`hf:…`), so ambiguous short forms (a bare number,
 *                   //   `user/repo`) are claimed only then
 *   async open(value, {signal, onStep}),
 *                   // → {title, attribution, catalog: {baseUrl}} for a dataset
 *                   //   catalog folder, or {title, attribution, file} for
 *                   //   one AnnData file (see `remote-file.js`), and
 *                   //   `locator` when what opened has a canonical value
 *                   //   of its own (a OneDrive share link opens as its
 *                   //   drive and item); `onStep(text)`
 *                   //   says what it is doing (`Listing the files of GSE…`),
 *                   //   shown by the opening progress; it makes as few
 *                   //   dependent round trips as the host allows
 *   auth?,          // {signIn, signOut, authorize(request)} for a provider
 *                   //   that reads behind a sign-in; tokens never leave it
 *                   //   but through `sources/access.js` to the reader
 * }
 * ```
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
  const capabilities = provider.capabilities;
  if (
    capabilities === null ||
    typeof capabilities !== 'object' ||
    typeof capabilities.folders !== 'boolean' ||
    !PRIVATE_MODES.has(capabilities.private) ||
    typeof capabilities.versions !== 'boolean' ||
    typeof capabilities.write !== 'boolean'
  ) {
    fail('capabilities must state folders, private, versions and write');
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
   * Resolve pasted text or a `?data=` value to one provider and its
   * canonical locator.
   *
   * @param {string} input
   * @returns {{provider: Object, value: string, locator: string}}
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
          `"${scheme[2]}" is not a valid ${provider.label} reference.`,
          DataSourceErrorCode.INVALID_FORMAT,
          'link',
          { input: text }
        );
      }
      return Object.freeze({ provider, value, locator: formatLocator(provider, value) });
    }
    for (const provider of this._providers.values()) {
      const value = provider.match(text, { explicit: false });
      if (value !== null) {
        return Object.freeze({ provider, value, locator: formatLocator(provider, value) });
      }
    }
    throw new DataSourceError(
      `Cellucid does not recognise "${text}". Paste a web address (an .h5ad ` +
      'file, a zipped Zarr store, a Zarr store folder, or a folder holding ' +
      'datasets.json ending in "/"), a GitHub repository (owner/repo/path), a Hugging Face dataset ' +
      '(hf:user/repo), a Zenodo record or DOI, a Figshare item or DOI, a Google Drive, OneDrive or ' +
      'Dropbox file link, a CELLxGENE dataset link or id, or a GEO series (GSE…).',
      DataSourceErrorCode.INVALID_FORMAT,
      'link',
      { input: text }
    );
  }
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

let defaultRegistry = null;

/** @returns {ProviderRegistry} */
export function getProviderRegistry() {
  defaultRegistry ??= new ProviderRegistry();
  return defaultRegistry;
}
