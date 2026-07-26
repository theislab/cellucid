import {
  DataSourceErrorCode,
  validateDatasetIdentity,
} from './data-source.js';

const GENERATION_KEYS = Object.freeze([
  'expectedIdentityId',
  'identity',
  'obsManifest',
  'varManifest',
  'connectivityManifest',
]);

const LOADER_KEYS = Object.freeze([
  'signal',
  'expectedIdentityId',
  'loadIdentity',
  'loadObsManifest',
  'loadVarManifest',
  'loadConnectivityManifest',
]);

const LOADER_FUNCTION_KEYS = Object.freeze([
  'loadIdentity',
  'loadObsManifest',
  'loadVarManifest',
  'loadConnectivityManifest',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactObject(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value);
  const missing = expectedKeys.filter(key => !Object.hasOwn(value, key));
  const unexpected = actualKeys.filter(key => !expectedKeys.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...(missing.length > 0
        ? [`missing key(s): ${missing.join(', ')}`]
        : []),
      ...(unexpected.length > 0
        ? [`unexpected key(s): ${unexpected.join(', ')}`]
        : []),
    ];
    throw new Error(`${label} has ${details.join('; ')}`);
  }
}

function requireManifestFields(manifest, filename) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.fields)) {
    throw new Error(
      `${filename} must be a validated manifest object with a fields array`
    );
  }
  if (!Number.isSafeInteger(manifest.n_points) || manifest.n_points <= 0) {
    throw new Error(
      `${filename} n_points must be a positive safe integer`
    );
  }
}

function deriveObsSummaries(obsManifest) {
  return obsManifest.fields.map((field, index) => {
    if (
      !isPlainObject(field) ||
      typeof field.key !== 'string' ||
      field.key.length === 0
    ) {
      throw new Error(
        `obs_manifest.json fields[${index}] must have a non-empty key`
      );
    }
    if (field.kind === 'continuous') {
      return { key: field.key, kind: field.kind };
    }
    if (field.kind === 'category' && Array.isArray(field.categories)) {
      return {
        key: field.key,
        kind: field.kind,
        n_categories: field.categories.length,
      };
    }
    throw new Error(
      `obs_manifest.json fields[${index}] has an invalid kind or categories`
    );
  });
}

function obsSummariesMatch(identitySummaries, manifestSummaries) {
  return (
    identitySummaries.length === manifestSummaries.length &&
    identitySummaries.every((expected, index) => {
      const actual = manifestSummaries[index];
      return (
        expected.key === actual.key &&
        expected.kind === actual.kind &&
        (
          expected.kind !== 'category' ||
          expected.n_categories === actual.n_categories
        )
      );
    })
  );
}

function validateConnectivitySummary(identity, manifest) {
  const { stats } = identity;
  if (manifest === null) {
    if (stats.has_connectivity) {
      throw new Error(
        'dataset_identity.json advertises connectivity, but ' +
        'connectivity_manifest.json is absent'
      );
    }
    return;
  }
  if (!stats.has_connectivity) {
    throw new Error(
      'dataset_identity.json does not advertise connectivity, but ' +
      'connectivity_manifest.json is present'
    );
  }
  if (
    !isPlainObject(manifest) ||
    manifest.format !== 'edge_pairs' ||
    !Number.isSafeInteger(manifest.n_cells) ||
    manifest.n_cells <= 0 ||
    !Number.isSafeInteger(manifest.n_edges) ||
    manifest.n_edges < 0 ||
    !Number.isSafeInteger(manifest.max_neighbors) ||
    manifest.max_neighbors < 0 ||
    manifest.max_neighbors > Math.max(0, manifest.n_cells - 1)
  ) {
    throw new Error(
      'connectivity_manifest.json must contain exact edge_pairs summaries'
    );
  }
  if (manifest.n_cells !== stats.n_cells) {
    throw new Error(
      `connectivity_manifest.json n_cells (${manifest.n_cells}) must ` +
      `equal dataset_identity.json stats.n_cells (${stats.n_cells})`
    );
  }
  if (manifest.n_edges !== stats.n_edges) {
    throw new Error(
      `dataset_identity.json stats.n_edges (${stats.n_edges}) must equal ` +
      `connectivity_manifest.json n_edges (${manifest.n_edges})`
    );
  }
}

/**
 * Validate the metadata bundle for one selected dataset generation.
 * Individual readers own each manifest schema; this boundary owns exact
 * cross-file identity, count, ordering, and declared-absence agreement.
 *
 * @param {{
 *   signal: AbortSignal,
 *   expectedIdentityId: string,
 *   identity: Object,
 *   obsManifest: Object,
 *   varManifest: Object|null,
 *   connectivityManifest: Object|null,
 * }} generation
 * @returns {typeof generation}
 */
export function validateDatasetGeneration(generation) {
  requireExactObject(generation, GENERATION_KEYS, 'dataset generation');
  const {
    expectedIdentityId,
    identity,
    obsManifest,
    varManifest,
    connectivityManifest,
  } = generation;

  if (
    typeof expectedIdentityId !== 'string' ||
    expectedIdentityId.length === 0
  ) {
    throw new TypeError(
      'dataset generation expectedIdentityId must be a non-empty string'
    );
  }
  if (
    !isPlainObject(identity) ||
    typeof identity.id !== 'string' ||
    identity.id.length === 0
  ) {
    throw new Error(
      'dataset_identity.json must contain its exact non-empty id'
    );
  }
  validateDatasetIdentity(
    identity,
    expectedIdentityId,
    'runtime-generation'
  );

  requireManifestFields(obsManifest, 'obs_manifest.json');
  if (obsManifest.n_points !== identity.stats.n_cells) {
    throw new Error(
      `obs_manifest.json n_points (${obsManifest.n_points}) must equal ` +
      `dataset_identity.json stats.n_cells (${identity.stats.n_cells})`
    );
  }
  const obsSummaries = deriveObsSummaries(obsManifest);
  if (!obsSummariesMatch(identity.obs_fields, obsSummaries)) {
    throw new Error(
      'dataset_identity.json obs_fields must exactly match ' +
      'obs_manifest.json in order, kind, and n_categories'
    );
  }

  if (varManifest === null) {
    if (identity.stats.n_genes !== 0) {
      throw new Error(
        `dataset_identity.json advertises ${identity.stats.n_genes} genes, ` +
        'but var_manifest.json is absent'
      );
    }
  } else {
    requireManifestFields(varManifest, 'var_manifest.json');
    if (varManifest.n_points !== identity.stats.n_cells) {
      throw new Error(
        `var_manifest.json n_points (${varManifest.n_points}) must equal ` +
        `dataset_identity.json stats.n_cells (${identity.stats.n_cells})`
      );
    }
    if (varManifest.fields.length !== identity.stats.n_genes) {
      throw new Error(
        `dataset_identity.json stats.n_genes ` +
        `(${identity.stats.n_genes}) must equal var_manifest.json field ` +
        `count (${varManifest.fields.length})`
      );
    }
  }

  validateConnectivitySummary(identity, connectivityManifest);
  return generation;
}

function isExactNotFound(error) {
  return (
    error?.status === 404 ||
    error?.code === DataSourceErrorCode.FILE_NOT_FOUND
  );
}

async function loadRequired(loader, filename, signal) {
  try {
    return await loader(signal);
  } catch (error) {
    if (isExactNotFound(error)) {
      throw new Error(`Missing required ${filename}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Load the exact identity first, derive the required artifact set from that
 * validated identity, and publish only after the selected generation is valid.
 *
 * @param {{
 *   expectedIdentityId: string,
 *   loadIdentity: (signal: AbortSignal) => Promise<Object>,
 *   loadObsManifest: (signal: AbortSignal) => Promise<Object>,
 *   loadVarManifest: (signal: AbortSignal) => Promise<Object>,
 *   loadConnectivityManifest: (signal: AbortSignal) => Promise<Object|null>,
 * }} loaders
 * @returns {Promise<{
 *   expectedIdentityId: string,
 *   identity: Object,
 *   obsManifest: Object,
 *   varManifest: Object|null,
 *   connectivityManifest: Object|null,
 * }>}
 */
export async function loadDatasetGeneration(loaders) {
  requireExactObject(loaders, LOADER_KEYS, 'dataset generation loaders');
  if (!(loaders.signal instanceof AbortSignal)) {
    throw new TypeError(
      'dataset generation signal must be an AbortSignal'
    );
  }
  if (
    typeof loaders.expectedIdentityId !== 'string' ||
    loaders.expectedIdentityId.length === 0
  ) {
    throw new TypeError(
      'dataset generation expectedIdentityId must be a non-empty string'
    );
  }
  for (const key of LOADER_FUNCTION_KEYS) {
    if (typeof loaders[key] !== 'function') {
      throw new TypeError(`${key} must be a function`);
    }
  }

  const controller = new AbortController();
  const parentSignal = loaders.signal;
  const abortFromParent = () => {
    controller.abort(
      parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new DOMException(
          'Dataset generation was aborted.',
          'AbortError'
        )
    );
  };
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener('abort', abortFromParent, {
      once: true,
    });
  }
  try {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    const identity = await loadRequired(
      loaders.loadIdentity,
      'dataset_identity.json',
      controller.signal
    );
    validateDatasetIdentity(
      identity,
      loaders.expectedIdentityId,
      'runtime-generation'
    );
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }

    const selectedOperations = [
      {
        key: 'obsManifest',
        load: () => loadRequired(
          loaders.loadObsManifest,
          'obs_manifest.json',
          controller.signal
        ),
      },
    ];
    if (identity.stats.n_genes > 0) {
      selectedOperations.push({
        key: 'varManifest',
        load: () => loadRequired(
          loaders.loadVarManifest,
          'var_manifest.json',
          controller.signal
        ),
      });
    }
    if (identity.stats.has_connectivity) {
      selectedOperations.push({
        key: 'connectivityManifest',
        load: () => loadRequired(
          loaders.loadConnectivityManifest,
          'connectivity_manifest.json',
          controller.signal
        ),
      });
    }

    let firstFailure = null;
    const settled = await Promise.allSettled(
      selectedOperations.map(async operation => {
        try {
          if (controller.signal.aborted) {
            throw controller.signal.reason;
          }
          return await operation.load();
        } catch (error) {
          if (firstFailure === null) {
            firstFailure = error;
            controller.abort(error);
          }
          throw error;
        }
      })
    );
    if (firstFailure !== null) {
      throw firstFailure;
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }

    const generation = {
      expectedIdentityId: loaders.expectedIdentityId,
      identity,
      obsManifest: null,
      varManifest: null,
      connectivityManifest: null,
    };
    for (let index = 0; index < selectedOperations.length; index++) {
      generation[selectedOperations[index].key] =
        settled[index].value;
    }
    return validateDatasetGeneration(generation);
  } finally {
    parentSignal.removeEventListener('abort', abortFromParent);
  }
}
