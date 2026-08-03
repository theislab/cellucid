/**
 * @module data/continuous-payload-diagnosis
 *
 * What to say when a continuous payload contains a value that cannot be drawn.
 *
 * A colour scale needs a finite minimum and maximum. `NaN` is representable —
 * Cellucid draws it as the neutral grey that means "no value here" — but an
 * infinity is not: it has no position on any scale, and it makes the whole
 * field's range infinite, so every other cell collapses onto one colour. The
 * reader therefore refuses a field containing one.
 *
 * Refusing is the easy half. The hard half is saying *why* in a way the person
 * looking at the screen can act on, and that is what this module exists for.
 * The failure it describes used to surface as
 *
 *     Continuous field value 4118237 must be finite or NaN.
 *
 * which names a flat index into an array the reader never showed anyone, does
 * not name the field, does not say whether the offender was an infinity or how
 * many there were, and does not say what to do. What replaces it names the
 * field, counts each kind of offending value, gives the first few cell indices,
 * and says which one line of Python or R fixes it.
 *
 * The scan is not an extra pass. `ensureContinuousMetadata` already visits every
 * value to find the range; this collects the counts on that same visit and
 * reports once at the end, rather than throwing on the first offender and
 * leaving the person to wonder whether it was one cell or a million.
 */

/** How many offending cell indices to name. Enough to check, few enough to read. */
export const NON_FINITE_EXAMPLE_LIMIT = 5;

/**
 * @typedef {object} NonFiniteTally
 * @property {number} nan Count of `NaN` values.
 * @property {number} positiveInfinity Count of `+Infinity` values.
 * @property {number} negativeInfinity Count of `-Infinity` values.
 * @property {number[]} examples First offending cell indices, `NaN` excluded.
 * @property {number} total Number of values examined.
 */

/**
 * Start one empty tally.
 *
 * @param {number} total
 * @returns {NonFiniteTally}
 */
export function createNonFiniteTally(total) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError(
      'Non-finite tally total must be a non-negative safe integer.'
    );
  }
  return {
    nan: 0,
    positiveInfinity: 0,
    negativeInfinity: 0,
    examples: [],
    total,
  };
}

/**
 * Record one value that is neither finite nor countable towards a range.
 *
 * @param {NonFiniteTally} tally
 * @param {number} value
 * @param {number} index
 */
export function recordNonFiniteValue(tally, value, index) {
  if (Number.isNaN(value)) {
    tally.nan++;
    return;
  }
  if (value === Number.POSITIVE_INFINITY) tally.positiveInfinity++;
  else tally.negativeInfinity++;
  if (tally.examples.length < NON_FINITE_EXAMPLE_LIMIT) {
    tally.examples.push(index);
  }
}

/** Whether the tally holds a value that has no position on a colour scale. */
export function hasUndrawableValues(tally) {
  return tally.positiveInfinity > 0 || tally.negativeInfinity > 0;
}

function formatCount(count) {
  return count.toLocaleString();
}

function describeKinds(tally) {
  const parts = [];
  if (tally.positiveInfinity > 0) {
    parts.push(`${formatCount(tally.positiveInfinity)} +Infinity`);
  }
  if (tally.negativeInfinity > 0) {
    parts.push(`${formatCount(tally.negativeInfinity)} -Infinity`);
  }
  if (tally.nan > 0) parts.push(`${formatCount(tally.nan)} NaN`);
  return parts.join(', ');
}

/**
 * The subject of the diagnosis, in the words the person chose.
 *
 * @typedef {object} ContinuousPayloadSubject
 * @property {'gene'|'field'} kind What the payload is, for the remedy wording.
 * @property {string} name The name shown in the UI: a gene symbol or a field key.
 */

function requireSubject(subject) {
  if (
    subject === null
    || typeof subject !== 'object'
    || Array.isArray(subject)
    || (subject.kind !== 'gene' && subject.kind !== 'field')
    || typeof subject.name !== 'string'
    || subject.name.length === 0
  ) {
    throw new TypeError(
      'Continuous payload subject must name one gene or field.'
    );
  }
  return subject;
}

const REMEDY_BY_KIND = Object.freeze({
  gene:
    'Repair the expression matrix before serving or exporting it — for example '
    + '`adata.X.data[~np.isfinite(adata.X.data)] = 0` for a sparse matrix, or '
    + '`np.nan_to_num(adata.X, copy=False)` for a dense one — then reload.',
  field:
    'Repair the column before serving or exporting it — for example '
    + '`adata.obs["<name>"] = adata.obs["<name>"].replace([np.inf, -np.inf], '
    + 'np.nan)` — then reload.',
});

/**
 * The complete message for a payload that cannot be drawn.
 *
 * Four lines, each answering one question, in the order a reader asks them:
 * what is wrong, how much of it, where, and what to do. The notification centre
 * renders newlines, so this reads as four lines on screen.
 *
 * @param {object} options
 * @param {ContinuousPayloadSubject} options.subject
 * @param {NonFiniteTally} options.tally
 * @returns {string}
 */
export function describeUndrawablePayload({ subject, tally }) {
  const owner = requireSubject(subject);
  const noun = owner.kind === 'gene' ? 'Gene' : 'Field';
  const undrawable = tally.positiveInfinity + tally.negativeInfinity;
  const examples = tally.examples
    .map(index => index.toLocaleString())
    .join(', ');
  const lines = [
    `${noun} "${owner.name}" contains ${formatCount(undrawable)} `
    + `infinite value${undrawable === 1 ? '' : 's'}, so it has no colour scale.`,
    `Of ${formatCount(tally.total)} cells: ${describeKinds(tally)}.`,
  ];
  if (examples.length > 0) {
    lines.push(
      `First affected cell${tally.examples.length === 1 ? '' : 's'}: ${examples}`
      + `${undrawable > tally.examples.length ? ', …' : ''}.`
    );
  }
  lines.push(
    'NaN is drawn as missing; an infinity is not a value on any scale.'
  );
  lines.push(REMEDY_BY_KIND[owner.kind].replaceAll('<name>', owner.name));
  return lines.join('\n');
}

/**
 * The complete message for a payload that holds no value at all.
 *
 * Distinct from the infinity case and from an empty download: every cell is
 * explicitly missing, so there is nothing to scale and nothing to colour, and
 * the remedy is different — this is usually a column that was never computed.
 *
 * @param {object} options
 * @param {ContinuousPayloadSubject} options.subject
 * @param {NonFiniteTally} options.tally
 * @returns {string}
 */
export function describeEmptyPayload({ subject, tally }) {
  const owner = requireSubject(subject);
  const noun = owner.kind === 'gene' ? 'Gene' : 'Field';
  return [
    `${noun} "${owner.name}" has no value in any of `
    + `${formatCount(tally.total)} cells, so it has no colour scale.`,
    `Every value is NaN, which Cellucid reads as "not measured here".`,
    owner.kind === 'gene'
      ? 'Check that the expression matrix being served is the one that was '
        + 'normalized, not an empty layer.'
      : 'Check that the column was computed for this dataset before it was '
        + 'served or exported.',
  ].join('\n');
}

/**
 * What a transport failure on a continuous payload most likely means.
 *
 * Keyed by HTTP status, in the cause-then-action shape `dataset-connections.js`
 * uses for data-source failures. The 500 entry is the one that matters here: the
 * Python server validates a gene column before it sends a byte, and a column
 * containing NaN or an infinity is refused — but that refusal is reported as a
 * bare internal error, so the browser cannot name the cause and can only say
 * where to read it. Everything else is the ordinary transport vocabulary.
 */
const TRANSPORT_FAILURES = Object.freeze({
  404: Object.freeze({
    cause: 'The server does not have this payload.',
    action:
      'The dataset may have been replaced while it was open. Reload the page '
      + 'to pick up the current manifest.',
  }),
  416: Object.freeze({
    cause: 'The server refused the byte range this payload was read with.',
    action: 'Reload the page to read the payload without a range request.',
  }),
  422: Object.freeze({
    // The server examined the payload and refused it. Its body carries the
    // counted reason, which is quoted above this line, so there is nothing to
    // add about the cause — only about what nothing else can say.
    cause:
      'The server examined this payload and will not publish it.',
    action:
      'Repair the values at the source and reload. Nothing in the viewer can '
      + 'work around a value that has no position on a colour scale.',
  }),
  500: Object.freeze({
    cause:
      'The server failed while producing the payload. For gene expression '
      + 'this is most often a column that is not entirely finite: the server '
      + 'refuses a gene containing NaN or ±Infinity, because neither has a '
      + 'position on a colour scale.',
    action:
      'A server new enough to say so answers 422 and names the gene. An older '
      + 'one prints the reason to its own console. If the values are the '
      + 'cause, repair the matrix — '
      + '`adata.X.data[~np.isfinite(adata.X.data)] = 0` for a sparse matrix, '
      + '`np.nan_to_num(adata.X, copy=False)` for a dense one — and restart '
      + 'the server.',
  }),
  503: Object.freeze({
    cause: 'The server is not serving this dataset right now.',
    action: 'Check that the `cellucid serve` process is still running.',
  }),
});

const UNCLASSIFIED_TRANSPORT_ACTION =
  'Check the server console for the request that failed.';

/**
 * The message to show when one continuous payload could not be presented.
 *
 * Three sources of failure reach this, and each already knows something the
 * others do not:
 *
 *   - the reader's own refusal, which has counted the offending values and
 *     needs nothing added;
 *   - a transport failure, where the status and whatever the server put in the
 *     body are all there is, plus what that status usually means here;
 *   - anything else, which is reported as itself rather than dressed up.
 *
 * @param {object} options
 * @param {ContinuousPayloadSubject} options.subject
 * @param {unknown} options.error
 * @returns {string}
 */
export function explainContinuousPayloadFailure({ subject, error }) {
  const owner = requireSubject(subject);
  if (error instanceof UndrawableContinuousPayloadError) {
    return error.message;
  }
  const noun = owner.kind === 'gene' ? 'Gene' : 'Field';
  const message = error instanceof Error
    ? error.message
    : String(error);
  const status = error instanceof Error && Number.isInteger(error.status)
    ? error.status
    : null;
  if (status === null) {
    return `${noun} "${owner.name}" could not be loaded.\n${message}`;
  }
  const classified = TRANSPORT_FAILURES[status] ?? null;
  const detail = typeof error.serverDetail === 'string'
    && error.serverDetail.length > 0
    ? error.serverDetail
    : null;
  const lines = [
    `${noun} "${owner.name}" could not be loaded: the server answered `
    + `${status}.`,
  ];
  if (detail !== null) lines.push(`The server said: ${detail}`);
  lines.push(classified === null ? message : classified.cause);
  lines.push(
    classified === null ? UNCLASSIFIED_TRANSPORT_ACTION : classified.action
  );
  return lines.join('\n');
}

/**
 * One error carrying the diagnosis, so a caller can present it without parsing
 * the message back apart.
 */
export class UndrawableContinuousPayloadError extends Error {
  /**
   * @param {object} options
   * @param {ContinuousPayloadSubject} options.subject
   * @param {NonFiniteTally} options.tally
   */
  constructor({ subject, tally }) {
    const owner = requireSubject(subject);
    const empty = !hasUndrawableValues(tally) && tally.nan === tally.total;
    super(
      empty
        ? describeEmptyPayload({ subject: owner, tally })
        : describeUndrawablePayload({ subject: owner, tally })
    );
    this.name = 'UndrawableContinuousPayloadError';
    this.subject = Object.freeze({ ...owner });
    this.tally = Object.freeze({
      ...tally,
      examples: Object.freeze([...tally.examples]),
    });
    this.isEmptyPayload = empty;
  }
}
