import {
  DATASET_RELOAD_SUPERSEDED_CODE,
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError
} from '../data/dataset-lifecycle-errors.js';

export {
  DATASET_RELOAD_SUPERSEDED_CODE,
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError
};

function attachSecondaryFailure(primaryError, secondaryError) {
  if (
    secondaryError === undefined ||
    secondaryError === null ||
    (
      (typeof primaryError !== 'object' || primaryError === null) &&
      typeof primaryError !== 'function'
    )
  ) {
    return primaryError;
  }
  try {
    if (
      !Object.hasOwn(primaryError, 'cause') ||
      primaryError.cause === undefined
    ) {
      Object.defineProperty(primaryError, 'cause', {
        configurable: true,
        value: secondaryError,
        writable: true
      });
      return primaryError;
    }
    const previous = Array.isArray(primaryError.secondaryErrors)
      ? primaryError.secondaryErrors
      : [];
    Object.defineProperty(primaryError, 'secondaryErrors', {
      configurable: true,
      value: Object.freeze([...previous, secondaryError]),
      writable: true
    });
  } catch {
    // A frozen/host error still remains the exact primary rejection.
  }
  return primaryError;
}

/**
 * Report a required dataset reload failure, then preserve that same rejection
 * for callers that own the final ready/failed notification.
 *
 * @param {unknown} error
 * @param {(error: unknown) => Promise<void>|void} reportFailure
 * @returns {Promise<never>}
 */
export async function reportRequiredDatasetReloadFailure(
  error,
  reportFailure
) {
  if (typeof reportFailure !== 'function') {
    throw new TypeError(
      'Required dataset reload failure reporter must be a function.'
    );
  }
  try {
    await reportFailure(error);
  } catch (reportingError) {
    attachSecondaryFailure(error, reportingError);
  }
  throw error;
}

const SUPPORTED_EMBEDDING_DIMENSIONS = new Set([1, 2, 3]);
const RELOAD_SUPERSEDED_MESSAGE =
  'Dataset reload was superseded by a newer selection.';

function requireExactKeys(value, expectedKeys, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object.`);
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
        : [])
    ];
    throw new Error(`${label} has ${details.join('; ')}.`);
  }
}

/**
 * Validate one advertised embedding payload against the canonical cell axis.
 * This boundary intentionally runs on the raw, unpadded coordinates so a 2D
 * dataset cannot be accepted merely because a later render buffer has a
 * plausible multiple-of-three length.
 *
 * @param {object} options
 * @param {Float32Array} options.positions
 * @param {object} options.identity
 * @param {number} options.dimension
 * @returns {Float32Array}
 */
export function validateDatasetPositionPayload(options) {
  requireExactKeys(
    options,
    ['positions', 'identity', 'dimension'],
    'dataset position validation'
  );
  const { positions, identity, dimension } = options;
  const nCells = identity?.stats?.n_cells;
  if (!Number.isSafeInteger(nCells) || nCells <= 0) {
    throw new Error(
      'dataset_identity.json stats.n_cells must be a positive safe integer.'
    );
  }
  if (
    !Number.isSafeInteger(dimension) ||
    !SUPPORTED_EMBEDDING_DIMENSIONS.has(dimension)
  ) {
    throw new Error(
      'Dataset position dimension must be exactly 1, 2, or 3.'
    );
  }
  if (
    !(positions instanceof Float32Array) ||
    positions.byteLength !==
      positions.length * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error(
      `${dimension}D dataset positions must be an exact Float32Array.`
    );
  }
  const expectedLength = nCells * dimension;
  if (
    !Number.isSafeInteger(expectedLength) ||
    positions.length !== expectedLength
  ) {
    throw new Error(
      `${dimension}D dataset positions contain ${positions.length} ` +
      `coordinates; dataset_identity.json stats.n_cells (${nCells}) ` +
      `requires exactly ${expectedLength} (${nCells} × ${dimension}).`
    );
  }
  for (let index = 0; index < positions.length; index++) {
    if (!Number.isFinite(positions[index])) {
      throw new Error(
        `${dimension}D dataset positions contain a non-finite coordinate ` +
        `at index ${index}.`
      );
    }
  }
  return positions;
}

/**
 * Load and validate a generation's default raw embedding before producing its
 * normalized three-coordinate render buffer. Nothing in DataState or Viewer is
 * published by this staging operation.
 *
 * @param {object} options
 * @param {object} options.generation
 * @param {object} options.dimensionManager
 * @param {boolean} options.showProgress
 * @param {AbortSignal} options.signal
 * @returns {Promise<Readonly<{
 *   defaultDimension: number,
 *   positions: Float32Array
 * }>>}
 */
export async function stageDatasetPositionPayload(options) {
  requireExactKeys(
    options,
    ['generation', 'dimensionManager', 'showProgress', 'signal'],
    'dataset position staging'
  );
  const {
    generation,
    dimensionManager,
    showProgress,
    signal
  } = options;
  if (typeof showProgress !== 'boolean') {
    throw new TypeError(
      'Dataset position staging showProgress must be a boolean.'
    );
  }
  if (
    typeof dimensionManager?.getDefaultDimension !== 'function' ||
    typeof dimensionManager?.loadDimension !== 'function' ||
    typeof dimensionManager?.getPositions3D !== 'function' ||
    typeof dimensionManager?.clearCache !== 'function'
  ) {
    throw new TypeError(
      'Dataset position staging requires a DimensionManager.'
    );
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError(
      'Dataset position staging signal must be an AbortSignal.'
    );
  }
  if (signal.aborted) {
    throw createDatasetReloadSupersededError(
      RELOAD_SUPERSEDED_MESSAGE
    );
  }

  const abortStaging = () => {
    dimensionManager.clearCache();
  };
  signal.addEventListener('abort', abortStaging, { once: true });

  try {
    const defaultDimension = dimensionManager.getDefaultDimension();
    const rawPositions = await dimensionManager.loadDimension(
      defaultDimension,
      { showProgress }
    );
    if (signal.aborted) {
      throw createDatasetReloadSupersededError(
        RELOAD_SUPERSEDED_MESSAGE
      );
    }
    validateDatasetPositionPayload({
      positions: rawPositions,
      identity: generation.identity,
      dimension: defaultDimension
    });

    const positions = await dimensionManager.getPositions3D(
      defaultDimension,
      { showProgress: false }
    );
    if (signal.aborted) {
      throw createDatasetReloadSupersededError(
        RELOAD_SUPERSEDED_MESSAGE
      );
    }
    validateDatasetPositionPayload({
      positions,
      identity: generation.identity,
      dimension: 3
    });
    if (dimensionManager.nCells !== generation.identity.stats.n_cells) {
      throw new Error(
        `DimensionManager cell count (${dimensionManager.nCells}) must equal ` +
        `dataset_identity.json stats.n_cells ` +
        `(${generation.identity.stats.n_cells}).`
      );
    }

    return Object.freeze({
      defaultDimension,
      positions
    });
  } finally {
    signal.removeEventListener('abort', abortStaging);
  }
}

function captureReloadIdentity(captureIdentity) {
  const identity = captureIdentity();
  requireExactKeys(
    identity,
    ['source', 'baseUrl', 'datasetId', 'selectionIdentity'],
    'dataset reload identity'
  );
  const {
    source,
    baseUrl,
    datasetId,
    selectionIdentity
  } = identity;
  if (
    source !== null &&
    (typeof source !== 'object' || Array.isArray(source))
  ) {
    throw new TypeError(
      'Dataset reload identity source must be an object or null.'
    );
  }
  if (
    baseUrl !== null &&
    (typeof baseUrl !== 'string' || baseUrl.length === 0)
  ) {
    throw new TypeError(
      'Dataset reload identity baseUrl must be a non-empty string or null.'
    );
  }
  if (
    datasetId !== null &&
    (typeof datasetId !== 'string' || datasetId.length === 0)
  ) {
    throw new TypeError(
      'Dataset reload identity datasetId must be a non-empty string or null.'
    );
  }
  if (
    selectionIdentity !== null &&
    (
      !Number.isSafeInteger(selectionIdentity) ||
      selectionIdentity < 0
    )
  ) {
    throw new TypeError(
      'Dataset reload identity selectionIdentity must be a ' +
      'non-negative safe integer or null.'
    );
  }
  if (
    (source === null) !== (baseUrl === null) ||
    (source === null) !== (datasetId === null) ||
    (source === null && selectionIdentity !== null)
  ) {
    throw new Error(
      'Dataset reload identity must describe either one exact selection ' +
      'or four explicit null fields.'
    );
  }
  return Object.freeze({
    source,
    baseUrl,
    datasetId,
    selectionIdentity
  });
}

function reloadIdentitiesMatch(left, right) {
  return (
    left.source === right.source &&
    left.baseUrl === right.baseUrl &&
    left.datasetId === right.datasetId &&
    left.selectionIdentity === right.selectionIdentity
  );
}

/**
 * Coordinate in-place dataset reloads. A transaction remains current only
 * while it is the newest reload and its captured source identity is unchanged.
 *
 * @param {() => object} captureIdentity
 * @returns {{begin: () => {
 *   adoptCurrentIdentity: () => void,
 *   isLatest: () => boolean,
 *   isCurrent: () => boolean,
 *   assertCurrent: () => void,
 *   signal: AbortSignal
 * }}}
 */
export function createLatestDatasetReloadCoordinator(captureIdentity) {
  if (typeof captureIdentity !== 'function') {
    throw new TypeError('Dataset reload identity capture must be a function.');
  }

  let latestGeneration = 0;
  let latestController = null;

  return Object.freeze({
    begin() {
      let identity = captureReloadIdentity(captureIdentity);
      latestController?.abort();
      const controller = new AbortController();
      latestController = controller;
      const generation = ++latestGeneration;
      let publicationIdentityAdopted = false;

      return Object.freeze({
        adoptCurrentIdentity() {
          if (
            controller.signal.aborted
            || generation !== latestGeneration
          ) {
            throw createDatasetReloadSupersededError(
              RELOAD_SUPERSEDED_MESSAGE
            );
          }
          if (publicationIdentityAdopted) {
            throw new Error(
              'Dataset reload publication identity was already adopted.'
            );
          }
          identity = captureReloadIdentity(captureIdentity);
          publicationIdentityAdopted = true;
        },
        signal: controller.signal,
        isLatest() {
          return generation === latestGeneration;
        },
        isCurrent() {
          return (
            !controller.signal.aborted &&
            generation === latestGeneration &&
            reloadIdentitiesMatch(
              identity,
              captureReloadIdentity(captureIdentity)
            )
          );
        },
        assertCurrent() {
          if (
            controller.signal.aborted ||
            generation !== latestGeneration ||
            !reloadIdentitiesMatch(
              identity,
              captureReloadIdentity(captureIdentity)
            )
          ) {
            throw createDatasetReloadSupersededError(
              RELOAD_SUPERSEDED_MESSAGE
            );
          }
        }
      });
    }
  });
}

/**
 * Own continuations for already-published runtimes independently from staging
 * requests. Starting a newer request does not invalidate the live runtime;
 * only a later successful publication advances this epoch.
 *
 * @returns {Readonly<{
 *   readonly generation: number,
 *   publish: (details?: object) => Readonly<object & {
 *     generation: number,
 *     signal: AbortSignal,
 *     isCurrent: () => boolean,
 *     assertCurrent: () => void
 *   }>
 * }>}
 */
export function createLatestDatasetPublicationContinuationOwner() {
  let activeSlot = null;
  let latestGeneration = 0;
  const reservedKeys = new Set([
    'assertCurrent',
    'generation',
    'isCurrent',
    'signal'
  ]);

  const owner = {
    get generation() {
      return latestGeneration;
    },
    publish(details = {}) {
      if (
        details === null ||
        typeof details !== 'object' ||
        Array.isArray(details) ||
        Object.getPrototypeOf(details) !== Object.prototype
      ) {
        throw new TypeError(
          'Dataset publication continuation details must be an object.'
        );
      }
      const detailKeys = Reflect.ownKeys(details);
      if (
        detailKeys.some(
          key => typeof key !== 'string' || reservedKeys.has(key)
        )
      ) {
        throw new Error(
          'Dataset publication continuation details contain a reserved key.'
        );
      }
      if (latestGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
          'Dataset publication continuation generation is exhausted.'
        );
      }

      const generation = latestGeneration + 1;
      const controller = new AbortController();
      let token;
      token = Object.freeze({
        ...details,
        generation,
        signal: controller.signal,
        isCurrent() {
          return (
            activeSlot?.token === token &&
            controller.signal.aborted === false
          );
        },
        assertCurrent() {
          if (
            activeSlot?.token !== token ||
            controller.signal.aborted
          ) {
            throw createDatasetReloadSupersededError(
              'Dataset continuation was superseded by a newer runtime publication.'
            );
          }
        }
      });

      const previousSlot = activeSlot;
      latestGeneration = generation;
      activeSlot = { controller, token };
      previousSlot?.controller.abort();
      return token;
    }
  };
  return Object.freeze(owner);
}

/**
 * Own the failure boundary for an in-place reload. Superseded work publishes
 * its exact cancellation outcome; only a still-current reload may publish
 * failure UI/analytics.
 *
 * @param {object} options
 * @param {unknown} options.error
 * @param {{isCurrent: () => boolean, assertCurrent: () => void}} options.transaction
 * @param {() => void} options.cancel
 * @param {(error: unknown) => Promise<void>|void} options.reportFailure
 * @returns {Promise<never>}
 */
export async function handleDatasetReloadFailure(options) {
  requireExactKeys(
    options,
    ['error', 'transaction', 'cancel', 'reportFailure'],
    'dataset reload failure'
  );
  const {
    error,
    transaction,
    cancel,
    reportFailure
  } = options;
  if (
    typeof transaction?.isCurrent !== 'function' ||
    typeof transaction?.assertCurrent !== 'function'
  ) {
    throw new TypeError(
      'Dataset reload failure transaction is invalid.'
    );
  }
  if (
    typeof cancel !== 'function' ||
    typeof reportFailure !== 'function'
  ) {
    throw new TypeError(
      'Dataset reload failure handlers must be functions.'
    );
  }
  if (!transaction.isCurrent()) {
    let cancellationError = null;
    try {
      cancel();
    } catch (error) {
      cancellationError = error;
    }
    let assertionError = null;
    try {
      transaction.assertCurrent();
    } catch (error) {
      assertionError = error;
    }
    const supersessionError =
      isDatasetReloadSupersededError(assertionError)
        ? assertionError
        : createDatasetReloadSupersededError(
            RELOAD_SUPERSEDED_MESSAGE
          );
    attachSecondaryFailure(supersessionError, cancellationError);
    if (
      assertionError !== null &&
      assertionError !== supersessionError
    ) {
      attachSecondaryFailure(supersessionError, assertionError);
    }
    throw supersessionError;
  }
  if (isDatasetReloadSupersededError(error)) {
    try {
      cancel();
    } catch (cancellationError) {
      attachSecondaryFailure(error, cancellationError);
    }
    throw error;
  }
  return reportRequiredDatasetReloadFailure(error, reportFailure);
}

const PUBLISHED_STATE_READY_OUTCOMES = new Set([
  'ready',
  'ready-state-canceled',
  'ready-state-error',
  'ready-state-replaced',
  'ready-state-restored'
]);

/**
 * Publish exactly one analytics terminal for the dataset reload that still
 * owns the generation after advertised-state restoration.
 *
 * @param {object} options
 * @param {{status: string}} options.outcome
 * @param {{isCurrent: () => boolean, assertCurrent: () => void}} options.transaction
 * @param {() => void} options.cancel
 * @param {() => void} options.complete
 * @returns {Promise<object>}
 */
export async function settlePublishedDatasetStateOutcome(options) {
  requireExactKeys(
    options,
    ['outcome', 'transaction', 'cancel', 'complete'],
    'published dataset state outcome'
  );
  const {
    outcome,
    transaction,
    cancel,
    complete
  } = options;
  if (
    outcome === null
    || typeof outcome !== 'object'
    || Array.isArray(outcome)
    || typeof outcome.status !== 'string'
  ) {
    throw new TypeError(
      'Published dataset state outcome must expose one status string.'
    );
  }
  if (
    typeof transaction?.isCurrent !== 'function'
    || typeof transaction?.assertCurrent !== 'function'
    || typeof cancel !== 'function'
    || typeof complete !== 'function'
  ) {
    throw new TypeError(
      'Published dataset state settlement owners are invalid.'
    );
  }
  if (
    outcome.status === 'superseded'
    || !transaction.isCurrent()
  ) {
    return handleDatasetReloadFailure({
      error: createDatasetReloadSupersededError(
        RELOAD_SUPERSEDED_MESSAGE
      ),
      transaction,
      cancel,
      reportFailure() {
        throw new Error(
          'A superseded dataset reload must not publish failure analytics.'
        );
      }
    });
  }
  if (!PUBLISHED_STATE_READY_OUTCOMES.has(outcome.status)) {
    throw new TypeError(
      `Published dataset state outcome "${outcome.status}" is invalid.`
    );
  }
  transaction.assertCurrent();
  complete();
  return outcome;
}

/**
 * Settle bootstrap analytics without converting an expected interactive
 * replacement into a terminal startup failure.
 *
 * @param {Parameters<typeof settlePublishedDatasetStateOutcome>[0]} options
 * @returns {Promise<object>}
 */
export async function settleInitialPublishedDatasetStateOutcome(options) {
  try {
    return await settlePublishedDatasetStateOutcome(options);
  } catch (error) {
    if (!isDatasetReloadSupersededError(error)) throw error;
    return Object.freeze({ status: 'superseded' });
  }
}

/**
 * Synchronize non-scientific UI after a complete dataset has already been
 * published. Resource finalization runs exactly once after synchronization,
 * including when synchronization throws. Either error is reported as a ready
 * dataset with impaired controls, never relabeled as a failed scientific
 * reload.
 *
 * @param {object} options
 * @param {() => Promise<void>|void} options.synchronize
 * @param {() => Promise<void>|void} options.finalize
 * @param {(error: unknown) => Promise<void>|void} options.reportFailure
 * @returns {Promise<
 *   {status: 'ready'} |
 *   {status: 'superseded', finalizationError?: unknown} |
 *   {status: 'ready-ui-error', error: unknown}
 * >}
 */
export async function settlePublishedDatasetUi(options) {
  requireExactKeys(
    options,
    ['synchronize', 'finalize', 'reportFailure'],
    'published dataset UI synchronization'
  );
  const { finalize, synchronize, reportFailure } = options;
  if (
    typeof synchronize !== 'function' ||
    typeof finalize !== 'function' ||
    typeof reportFailure !== 'function'
  ) {
    throw new TypeError(
      'Published dataset UI synchronization handlers must be functions.'
    );
  }
  const errors = [];
  try {
    await synchronize();
  } catch (error) {
    errors.push(error);
  }
  try {
    await finalize();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 0) return { status: 'ready' };
  const supersessionError = errors.find(
    isDatasetReloadSupersededError
  );
  if (supersessionError !== undefined) {
    const finalizationError = errors.find(
      error => error !== supersessionError
    );
    return finalizationError === undefined
      ? { status: 'superseded' }
      : { status: 'superseded', finalizationError };
  }
  const error = errors.length === 1
    ? errors[0]
    : new AggregateError(
        errors,
        'Dataset UI synchronization and resource retirement failed.'
      );
  try {
    await reportFailure(error);
  } catch (reportingError) {
    if (reportingError === error) throw error;
    throw new AggregateError(
      [error, reportingError],
      'Dataset UI settlement and failure reporting both failed.'
    );
  }
  return { status: 'ready-ui-error', error };
}

/**
 * Create one exact owner for cache-bearing runtime resources. A retirement is
 * attempted at most once even when clearCache() itself throws, preventing
 * failure handlers from repeatedly touching an already-invalid generation.
 *
 * @returns {Readonly<{retire(resource: Object): boolean}>}
 */
export function createDatasetRuntimeRetirementOwner() {
  const retiredResources = new WeakSet();
  return Object.freeze({
    retire(resource) {
      if (
        resource === null ||
        typeof resource !== 'object' ||
        typeof resource.clearCache !== 'function'
      ) {
        throw new TypeError(
          'Dataset runtime retirement requires one cache-bearing resource.'
        );
      }
      if (retiredResources.has(resource)) return false;
      retiredResources.add(resource);
      resource.clearCache();
      return true;
    }
  });
}

/**
 * Activate validated local data while distinguishing a retained-source
 * auto-switch outcome from a required reload failure after the switch succeeds.
 *
 * @param {object} options
 * @param {() => Promise<void>|void} options.switchDataset
 * @param {() => Promise<void>|void} options.reloadDataset
 * @returns {Promise<
 *   {status: 'ready'} |
 *   {status: 'validated-retained', error: unknown}
 * >}
 */
export async function activateValidatedLocalDataset(options) {
  requireExactKeys(
    options,
    ['switchDataset', 'reloadDataset'],
    'validated local dataset activation'
  );
  const { switchDataset, reloadDataset } = options;
  if (
    typeof switchDataset !== 'function' ||
    typeof reloadDataset !== 'function'
  ) {
    throw new TypeError(
      'Validated local dataset activation handlers must be functions.'
    );
  }
  try {
    await switchDataset();
  } catch (error) {
    return { status: 'validated-retained', error };
  }

  await reloadDataset();
  return { status: 'ready' };
}
