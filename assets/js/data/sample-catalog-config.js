/**
 * The page's sample catalog (`DATA_CONFIG`), read once when the page loads
 * this module: from the page's address and its `cellucid-sample-catalog` meta
 * element. A module of the page only: the reader worker imports
 * `data-source.js`, and a worker has no page address and no document.
 */

/**
 * The sample catalog: the folder holding the `datasets.json` of the Sample
 * dataset list (`sources/anndata-catalog.js`), named by the page's one
 * `cellucid-sample-catalog` meta element, or for one launch by one
 * `sampleCatalog` query field.
 */
const SAMPLE_CATALOG_QUERY_KEY = 'sampleCatalog';
const SAMPLE_CATALOG_META_SELECTOR =
  'meta[name="cellucid-sample-catalog"]';

function sampleCatalogConfigurationError(message) {
  const error = new Error(`Sample dataset configuration: ${message}`);
  error.name = 'ConfigurationError';
  return error;
}

/**
 * What the person is told of a `sampleCatalog` the link names that cannot be
 * used: the link's, never "not in a format Cellucid can read".
 */
const SAMPLE_CATALOG_LINK_SENTENCES = Object.freeze({
  twice: 'This link names "sampleCatalog" more than once; a link names it once.',
  address: 'This link\'s "sampleCatalog" is not the address of a folder of datasets: it is one web address '
    + 'of a folder holding datasets.json, ending in "/" (https://host/folder/).',
});

/** The configuration failure of the link's `sampleCatalog`, said for the person. */
function sampleCatalogLinkError(cause, sentence) {
  const error = sampleCatalogConfigurationError(cause.message.replace(/^Sample dataset configuration: /, ''));
  error.sentence = sentence;
  error.parameter = SAMPLE_CATALOG_QUERY_KEY;
  return error;
}

function requireCanonicalPathSegments(pathname, owner) {
  const segments = pathname.split('/').slice(1);
  if (segments.at(-1) === '') segments.pop();
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw sampleCatalogConfigurationError(
        `${owner} contains invalid percent encoding`
      );
    }
    if (
      segment.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(decoded) ||
      encodeURIComponent(decoded) !== segment
    ) {
      throw sampleCatalogConfigurationError(
        `${owner} contains a non-canonical path segment`
      );
    }
  }
}

function validateSampleCatalogUrl(value, owner) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw sampleCatalogConfigurationError(
      `${owner} must contain one exact non-empty URL`
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw sampleCatalogConfigurationError(
      `${owner} must be an absolute HTTP(S) URL`
    );
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !parsed.pathname.endsWith('/') ||
    parsed.href !== value
  ) {
    throw sampleCatalogConfigurationError(
      `${owner} must be one canonical HTTP(S) folder URL with a trailing /`
    );
  }
  requireCanonicalPathSegments(parsed.pathname, owner);
  return parsed.href;
}

function readSampleCatalogConfiguration() {
  if (
    typeof window === 'undefined' ||
    typeof window.location?.href !== 'string'
  ) {
    return { url: null, error: null };
  }
  try {
    const pageUrl = new URL(window.location.href);
    const queryValues =
      pageUrl.searchParams.getAll(SAMPLE_CATALOG_QUERY_KEY);
    if (queryValues.length > 1) {
      throw sampleCatalogLinkError(
        sampleCatalogConfigurationError(`exactly one '${SAMPLE_CATALOG_QUERY_KEY}' query field is allowed`),
        SAMPLE_CATALOG_LINK_SENTENCES.twice
      );
    }
    if (queryValues.length === 1) {
      let url;
      try {
        url = validateSampleCatalogUrl(queryValues[0], SAMPLE_CATALOG_QUERY_KEY);
      } catch (error) {
        throw sampleCatalogLinkError(error, SAMPLE_CATALOG_LINK_SENTENCES.address);
      }
      return { url, error: null };
    }

    if (typeof document === 'undefined') {
      return { url: null, error: null };
    }
    const metas = document.querySelectorAll(SAMPLE_CATALOG_META_SELECTOR);
    if (metas.length > 1) {
      throw sampleCatalogConfigurationError(
        'exactly one cellucid-sample-catalog meta element is allowed'
      );
    }
    if (metas.length === 0) {
      return { url: null, error: null };
    }
    return {
      url: validateSampleCatalogUrl(
        metas[0].getAttribute('content'),
        'cellucid-sample-catalog meta content'
      ),
      error: null,
    };
  } catch (error) {
    return {
      url: null,
      error: error instanceof Error
        ? error
        : sampleCatalogConfigurationError(String(error)),
    };
  }
}

const sampleCatalogConfiguration = readSampleCatalogConfiguration();

export const DATA_CONFIG = {
  /** The sample catalog folder, or null when the page names none. */
  SAMPLE_CATALOG_URL: sampleCatalogConfiguration.url,
  /** Why the page's sample catalog configuration was refused, or null. */
  SAMPLE_CATALOG_CONFIGURATION_ERROR: sampleCatalogConfiguration.error,
};
