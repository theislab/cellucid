/**
 * Exact current wire contract for community annotation repositories.
 *
 * These validators accept JSON values without rewriting them. Callers must
 * validate before publishing, caching, or mutating session state.
 *
 * The repository template, theislab/cellucid-annotation, states the same
 * contract as JSON Schemas (`annotations/schema.json`,
 * `annotations/config.schema.json`, `annotations/moderation/merges.schema.json`)
 * and a Python validator (`scripts/validate_user_files.py`). One accept/reject
 * corpus, generated there by `scripts/generate_contract_corpus.py` and copied
 * byte for byte to `tests/fixtures/community-annotation-contract-corpus.json`,
 * holds this module and that validator to the same verdict on every case.
 */

/*
 * Files and dataset views.
 *
 * A repository can annotate several datasets, and two datasets can share a
 * field and a category label ("leiden" / "0"), so everything a contributor
 * writes is kept per dataset:
 *
 * - a user file (version 3) holds the profile once and, under
 *   `datasets[<datasetId>]`, that dataset's access record, suggestions, votes,
 *   comments and deletion markers;
 * - the merges file (version 3) names the dataset of every merge;
 * - the configuration file (version 1) lists the supported datasets.
 *
 * The app works on one dataset at a time, so `github-sync.js` projects each
 * file onto the open dataset (a *dataset view*: the shape `assertUserDocument`
 * and `assertMergesDocument` validate, version 1 of its own) when it pulls,
 * and composes the file back from the view when it publishes, replacing only
 * that dataset's part and keeping every other dataset's part byte for byte.
 * A projection reads only the open dataset's part: another dataset's section
 * is not this dataset's business, so it can never make a file fail here.
 * Nothing else in the app reads or writes the file shapes.
 *
 * Suggestion identifiers (user file and merges version 3).
 *
 * Every suggestion id is `<owner>_<rest>`: `<owner>` is the proposer's
 * `ghid_<n>` and `<rest>` is exact nonblank text without `:` (the app writes
 * `${ghid}_${crypto.randomUUID()}`). A suggestion's id starts with its own
 * `proposedBy` and `_`, and the digits of `ghid_<n>` end at that `_`, so
 * `ghid_1_` never prefixes `ghid_12_...`: no contributor can write an id that
 * collides with, or claims to be, another contributor's suggestion. Votes,
 * comments and merges may name anyone's suggestion; deletion markers name
 * only the file owner's.
 */

export const ANNOTATION_USER_FILE_VERSION = 3;
export const ANNOTATION_MERGES_FILE_VERSION = 3;
const ANNOTATION_CONFIG_FILE_VERSION = 1;
const DATASET_VIEW_VERSION = 1;

/**
 * Git blob object ids (the SHA-1 of `blob <byte length>\0<bytes>`) of the
 * canonical schema files of theislab/cellucid-annotation:
 * `annotations/schema.json` (user), `annotations/config.schema.json` (config)
 * and `annotations/moderation/merges.schema.json` (merges). A repository is
 * accepted only when those paths hold exactly these blobs. Its Git tree names
 * their ids, so nothing is downloaded to check them; the shared corpus carries
 * the schema texts and the web suite recomputes these ids from them.
 */
export const ANNOTATION_SCHEMA_BLOB_OIDS = Object.freeze({
  user: '9c7263612ce91052cddca9bc5b25680bcaf09194',
  config: '967093fe91eb99234239399ab067d63305952a6b',
  merges: '102bae917d6fe7810acb5c494cee498ceadf6e27',
});

// GitHub's repository Contents API returns a file's content as JSON only up
// to 1 MB (https://docs.github.com/en/rest/repos/contents#get-repository-content).
// Keep this as one shared browser/Worker boundary so publication and remote
// reconciliation cannot drift. It is the only size bound of the contract:
// nothing a contributor types and nothing a file counts has a limit of its own.
export const ANNOTATION_FILE_MAX_UTF8_BYTES = 1_000_000;

// The deepest JSON nesting either validator reads. The repository validator
// is Python, whose json decoder recurses once per nesting level and stops at
// the interpreter's recursion limit (sys.getrecursionlimit(), 1000 by default:
// https://docs.python.org/3/library/sys.html#sys.getrecursionlimit), so it
// cannot read deeper JSON on every Python it supports; this module refuses the
// same documents with the same sentence. No valid annotation document nests
// deeper than 7 levels (user file > datasets > section > suggestions > bucket
// list > suggestion > markers > marker), so the bound never refuses a valid
// file. The shared corpus pins the value for both validators.
const ANNOTATION_JSON_MAX_DEPTH = 512;

/**
 * The whitespace of the annotation contract, as one regular-expression
 * character class: the union of ECMAScript `\s` and Python's `str.isspace()`
 * (Python adds U+001C-U+001F and U+0085; ECMAScript adds U+FEFF). The schemas,
 * this module, the session and the repository validator all use exactly this
 * class, so a string is "exact" in the same way everywhere.
 */
export const ANNOTATION_WHITESPACE_CLASS =
  '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a' +
  '\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';

const WHITESPACE = new RegExp(ANNOTATION_WHITESPACE_CLASS);
const BLANK = new RegExp(`^${ANNOTATION_WHITESPACE_CLASS}*$`);

/**
 * Exact nonblank text: a string whose first and last characters are both
 * outside `ANNOTATION_WHITESPACE_CLASS` (so it is not empty either). Every
 * text a contributor writes into a file has this form; it is never trimmed.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAnnotationExactNonblank(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !WHITESPACE.test(value[0]) &&
    !WHITESPACE.test(value[value.length - 1])
  );
}

const ORCID_ID = /^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$/;
// LinkedIn's public profile handle: lowercase letters, digits and hyphens,
// at least 3 characters (LinkedIn's own minimum for a custom profile URL).
const LINKEDIN_HANDLE = /^[a-z0-9-]{3,}$/;

/**
 * An ORCID iD in its one exact form `0000-0000-0000-000X`, with a valid ISO
 * 7064 MOD 11-2 check character
 * (https://support.orcid.org/hc/en-us/articles/360006897674).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isExactOrcidId(value) {
  if (typeof value !== 'string' || !ORCID_ID.test(value)) return false;
  const compact = value.replaceAll('-', '');
  let total = 0;
  for (let index = 0; index < 15; index += 1) {
    total = (total + Number(compact[index])) * 2;
  }
  const result = (12 - (total % 11)) % 11;
  const expected = result === 10 ? 'X' : `${result}`;
  return compact[15] === expected;
}

/**
 * A LinkedIn handle exactly as it appears in a profile URL: no `@`, no URL.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isExactLinkedInHandle(value) {
  return typeof value === 'string' && LINKEDIN_HANDLE.test(value);
}

const UTC_DATE_TIME =
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})T(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})(?:\.(?<millisecond>[0-9]{3}))?Z$/;
const GHID = /^ghid_[1-9][0-9]*$/;
const SUGGESTION_ID_OWNER = /^ghid_[1-9][0-9]*(?=_)/;

/**
 * `fk~<urlencoded>` is the v1 bucket representation for a field key containing
 * `:`. A colon-free raw field key with the same shape would encode to the same
 * bucket, so reserve only that exact ambiguous raw-key subset.
 */
export function isReservedAnnotationFieldKey(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('fk~') &&
    !value.includes(':') &&
    /%3[Aa]/.test(value.slice(3))
  );
}

export function hasAnnotationSuggestionIdDelimiter(value) {
  return typeof value === 'string' && value.includes(':');
}

/**
 * The owner a suggestion id names: `'ghid_<n>'` for an id of the form
 * `ghid_<n>_<rest>` (`<rest>` exact nonblank text without `:`), else null.
 *
 * @param {unknown} id
 * @returns {string|null}
 */
/**
 * The text two suggestion labels (or two agreed consensus labels) are
 * compared by: the exact label in Unicode Normalization Form C, so the same
 * text typed or pasted in composed and decomposed form ("é" as one or two
 * code points) is one label. Nothing else is folded (no case, no inner
 * whitespace): "T cell" and "T Cell" stay apart. The one rule for label
 * identity: consensus bundles, the duplicate check of a new suggestion, an
 * agent naming a suggestion by its label, and the consensus column.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function exactLabelForCompare(value) {
  return typeof value === 'string' ? value.normalize('NFC') : '';
}

export function annotationSuggestionIdOwner(id) {
  if (typeof id !== 'string') return null;
  const owner = SUGGESTION_ID_OWNER.exec(id)?.[0];
  if (owner === undefined) return null;
  const rest = id.slice(owner.length + 1);
  return !rest.includes(':') && isAnnotationExactNonblank(rest) ? owner : null;
}

class AnnotationContractError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'AnnotationContractError';
    this.code = 'COMMUNITY_ANNOTATION_CONTRACT_INVALID';
    this.path = path;
  }
}

export class AnnotationFileTooLargeError extends Error {
  constructor(
    path,
    actualBytes,
    { phase = 'publication-preflight' } = {}
  ) {
    super(
      `${path} is ${actualBytes} UTF-8 bytes; GitHub Contents supports at ` +
      `most ${ANNOTATION_FILE_MAX_UTF8_BYTES} bytes`
    );
    this.name = 'AnnotationFileTooLargeError';
    this.code = 'COMMUNITY_ANNOTATION_FILE_TOO_LARGE';
    this.path = path;
    this.phase = phase;
    this.maxBytes = ANNOTATION_FILE_MAX_UTF8_BYTES;
    this.actualBytes = actualBytes;
  }
}

export function toAnnotationPublicationBytes(value, { path } = {}) {
  if (!isAnnotationExactNonblank(path)) {
    throw new Error('Annotation publication path must be an exact nonblank string');
  }
  if (typeof TextEncoder === 'undefined') {
    throw new Error('TextEncoder is required for annotation publication');
  }
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string') {
    throw new Error(`${path} must be a JSON document`);
  }
  const bytes = new TextEncoder().encode(`${serialized}\n`);
  if (bytes.byteLength > ANNOTATION_FILE_MAX_UTF8_BYTES) {
    throw new AnnotationFileTooLargeError(path, bytes.byteLength);
  }
  return bytes;
}

function reject(path, message) {
  throw new AnnotationContractError(path, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value, path) {
  if (!isRecord(value)) reject(path, 'must be a JSON object');
  return value;
}

function assertExactFields(value, path, required, optional = []) {
  const object = assertRecord(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) reject(path, `unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      reject(path, `missing required field ${JSON.stringify(key)}`);
    }
  }
  return object;
}

function child(path, key) {
  return `${path}[${JSON.stringify(key)}]`;
}

function assertString(value, path) {
  if (typeof value !== 'string') reject(path, 'must be a JSON string');
  return value;
}

function assertExactNonblank(value, path) {
  const string = assertString(value, path);
  if (!isAnnotationExactNonblank(string)) {
    reject(
      path,
      BLANK.test(string)
        ? 'must be nonblank'
        : 'must not have leading or trailing whitespace'
    );
  }
  return string;
}

function assertNullableExactNonblank(value, path) {
  if (value === null) return null;
  const string = assertString(value, path);
  if (!isAnnotationExactNonblank(string)) {
    reject(
      path,
      BLANK.test(string)
        ? 'must be nonblank or null'
        : 'must not have leading or trailing whitespace'
    );
  }
  return string;
}

function assertFieldKey(value, path) {
  const field = assertExactNonblank(value, path);
  if (isReservedAnnotationFieldKey(field)) {
    reject(
      path,
      'uses the reserved fk~...%3A field-key encoding form'
    );
  }
  return field;
}

/** Validate one suggestion id and return the owner it names. */
function assertSuggestionId(value, path) {
  const id = assertString(value, path);
  if (hasAnnotationSuggestionIdDelimiter(id)) {
    reject(path, 'suggestion identifiers must not contain the ":" delimiter');
  }
  assertExactNonblank(id, path);
  const owner = annotationSuggestionIdOwner(id);
  if (owner === null) {
    reject(
      path,
      'suggestion identifiers must have the form ghid_<n>_<id>: ' +
      'the proposer\'s identity, "_", then the rest of the id'
    );
  }
  return owner;
}

function assertInteger(value, path, { min, max } = {}) {
  if (!Number.isSafeInteger(value)) reject(path, 'must be a JSON safe integer');
  if (min !== undefined && value < min) reject(path, `must be at least ${min}`);
  if (max !== undefined && value > max) reject(path, `must be at most ${max}`);
  return value;
}

function assertNumber(value, path, { min, max } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    reject(path, 'must be a finite JSON number');
  }
  if (min !== undefined && value < min) reject(path, `must be at least ${min}`);
  if (max !== undefined && value > max) reject(path, `must be at most ${max}`);
  return value;
}

function assertArray(value, path, { min = 0 } = {}) {
  if (!Array.isArray(value)) reject(path, 'must be a JSON array');
  if (value.length < min) reject(path, `must contain at least ${min} item(s)`);
  return value;
}

function assertUniqueStrings(values, path) {
  const seen = new Set();
  values.forEach((value, index) => {
    if (seen.has(value)) reject(`${path}[${index}]`, 'duplicates an earlier item');
    seen.add(value);
  });
}

// One JSON string token. Unrolled (`plain* (escape plain*)*`), so a long
// string is one native scan however long it is.
const JSON_STRING_TOKEN =
  /"[^"\\\u0000-\u001f]*(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})[^"\\\u0000-\u001f]*)*"/y;
const JSON_NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** Say where and why a string token that did not match is invalid. */
function describeInvalidString(text, start) {
  if (text[start] !== '"') return [start, 'expected a JSON string'];
  let index = start + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code < 0x20) return [index, 'unescaped control character in JSON string'];
    if (code === 0x5c) {
      const escape = text[index + 1];
      if (escape === undefined) return [index, 'unterminated JSON string escape'];
      if (escape === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
          return [index, 'invalid JSON Unicode escape'];
        }
        index += 6;
        continue;
      }
      if (!'"\\/bfnrt'.includes(escape)) return [index, 'invalid JSON string escape'];
      index += 2;
      continue;
    }
    index += 1;
  }
  return [start, 'unterminated JSON string'];
}

/**
 * Parse JSON while rejecting duplicate object keys.
 *
 * Native JSON.parse keeps the last duplicate key, which would make the browser
 * contract weaker than the repository validator, so this parser builds the
 * value itself and compares decoded keys (`"name"` and `"name"` are
 * duplicates). It accepts exactly the JSON that JSON.parse accepts (nested at
 * most `ANNOTATION_JSON_MAX_DEPTH` levels) and returns the same value.
 *
 * One pass, not a duplicate-key scan followed by JSON.parse: measured on
 * 1 MB annotation files (median of 60 runs, Node 26, Apple M-series), this
 * pass takes 5.4 ms where the scan plus JSON.parse took 8.9 ms (many short
 * tokens), 1.1 ms where it took 5.1 ms (long texts) and 3.5 ms where it took
 * 8.9 ms (escaped texts). Each string is matched by one sticky regular
 * expression and handed to JSON.parse only when it holds an escape, so a long
 * text is one native scan; a megabyte that never closes its string is refused
 * in about 9 ms.
 */
export function parseExactJson(text, { path = '$' } = {}) {
  if (typeof text !== 'string') reject(path, 'JSON input must be a string');

  let index = 0;
  const length = text.length;
  const syntax = (message, at = index) =>
    reject(`${path} at character ${at}`, message);
  const skipWhitespace = () => {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code !== 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) return;
      index += 1;
    }
  };
  const parseString = () => {
    JSON_STRING_TOKEN.lastIndex = index;
    const match = JSON_STRING_TOKEN.exec(text);
    if (match === null) {
      const [at, message] = describeInvalidString(text, index);
      syntax(message, at);
    }
    index = JSON_STRING_TOKEN.lastIndex;
    const token = match[0];
    return token.includes('\\') ? JSON.parse(token) : token.slice(1, -1);
  };

  const parseValue = (depth) => {
    skipWhitespace();
    if (index >= length) syntax('expected a JSON value');
    const code = text.charCodeAt(index);

    if (code === 0x22) return parseString();
    if (code === 0x7b || code === 0x5b) {
      if (depth >= ANNOTATION_JSON_MAX_DEPTH) {
        syntax(`JSON nesting exceeds ${ANNOTATION_JSON_MAX_DEPTH} levels`);
      }
      index += 1;
      skipWhitespace();
      if (code === 0x5b) {
        const array = [];
        if (text.charCodeAt(index) === 0x5d) {
          index += 1;
          return array;
        }
        while (true) {
          array.push(parseValue(depth + 1));
          skipWhitespace();
          const next = text.charCodeAt(index);
          if (next === 0x5d) {
            index += 1;
            return array;
          }
          if (next !== 0x2c) syntax('expected "," or "]" in JSON array');
          index += 1;
        }
      }
      const object = {};
      if (text.charCodeAt(index) === 0x7d) {
        index += 1;
        return object;
      }
      while (true) {
        skipWhitespace();
        const keyAt = index;
        const key = parseString();
        if (Object.hasOwn(object, key)) {
          syntax(`duplicate JSON object key ${JSON.stringify(key)}`, keyAt);
        }
        skipWhitespace();
        if (text.charCodeAt(index) !== 0x3a) syntax('expected ":" after JSON object key');
        index += 1;
        const value = parseValue(depth + 1);
        if (key === '__proto__') {
          // JSON.parse defines `__proto__` as an own data property; an
          // assignment would set the object's prototype instead.
          Object.defineProperty(object, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } else {
          object[key] = value;
        }
        skipWhitespace();
        const next = text.charCodeAt(index);
        if (next === 0x7d) {
          index += 1;
          return object;
        }
        if (next !== 0x2c) syntax('expected "," or "}" in JSON object');
        index += 1;
      }
    }
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return null;
    }
    JSON_NUMBER_TOKEN.lastIndex = index;
    const number = JSON_NUMBER_TOKEN.exec(text);
    if (number === null) syntax('invalid JSON value');
    index = JSON_NUMBER_TOKEN.lastIndex;
    return Number(number[0]);
  };

  const value = parseValue(0);
  skipWhitespace();
  if (index !== length) syntax('unexpected content after the JSON value');
  return value;
}

export function assertUtcDateTime(value, path = '$') {
  const string = assertString(value, path);
  const match = UTC_DATE_TIME.exec(string);
  if (!match?.groups) {
    reject(
      path,
      'must use YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DDTHH:MM:SS.sssZ UTC form'
    );
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = Number(match.groups.second);
  const millisecond = Number(match.groups.millisecond || 0);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    reject(path, 'must be a real UTC calendar date and clock time');
  }
  return string;
}

function assertGhid(value, path) {
  const string = assertString(value, path);
  if (!GHID.test(string)) reject(path, 'must have the exact form ghid_<GitHub user id>');
  return string;
}

function assertBucket(value, path) {
  const bucket = assertExactNonblank(value, path);
  const delimiter = bucket.indexOf(':');
  if (delimiter <= 0 || delimiter === bucket.length - 1) {
    reject(path, 'must have <fieldKey>:<categoryLabel> form');
  }
  if (
    !isAnnotationExactNonblank(bucket.slice(0, delimiter)) ||
    !isAnnotationExactNonblank(bucket.slice(delimiter + 1))
  ) {
    reject(path, 'fieldKey and categoryLabel must both be nonblank without edge whitespace');
  }
  return bucket;
}

export function assertAnnotationBucket(value, path = '$') {
  return assertBucket(value, path);
}

function assertSuggestion(value, path, fileUser, suggestionIds) {
  const suggestion = assertExactFields(
    value,
    path,
    ['id', 'label', 'proposedBy', 'proposedAt'],
    ['ontologyId', 'evidence', 'markers', 'editedAt']
  );
  const idPath = child(path, 'id');
  const owner = assertSuggestionId(suggestion.id, idPath);
  if (suggestionIds.has(suggestion.id)) reject(idPath, 'must be globally unique');
  suggestionIds.add(suggestion.id);
  assertExactNonblank(suggestion.label, child(path, 'label'));
  if (Object.hasOwn(suggestion, 'ontologyId')) {
    assertNullableExactNonblank(suggestion.ontologyId, child(path, 'ontologyId'));
  }
  if (Object.hasOwn(suggestion, 'evidence')) {
    assertNullableExactNonblank(suggestion.evidence, child(path, 'evidence'));
  }
  if (Object.hasOwn(suggestion, 'markers') && suggestion.markers !== null) {
    const markers = assertArray(suggestion.markers, child(path, 'markers'));
    markers.forEach((marker, index) => {
      const markerPath = `${child(path, 'markers')}[${index}]`;
      if (typeof marker === 'string') {
        assertExactNonblank(marker, markerPath);
        return;
      }
      const record = assertExactFields(marker, markerPath, ['gene'], ['logFC', 'pval']);
      assertExactNonblank(record.gene, child(markerPath, 'gene'));
      if (Object.hasOwn(record, 'logFC')) {
        assertNumber(record.logFC, child(markerPath, 'logFC'));
      }
      if (Object.hasOwn(record, 'pval')) {
        assertNumber(record.pval, child(markerPath, 'pval'));
      }
    });
  }
  const proposedBy = assertGhid(suggestion.proposedBy, child(path, 'proposedBy'));
  if (proposedBy !== fileUser) {
    reject(child(path, 'proposedBy'), `must equal file identity ${JSON.stringify(fileUser)}`);
  }
  if (owner !== proposedBy) {
    reject(
      idPath,
      `must start with ${JSON.stringify(`${proposedBy}_`)}, its proposer's identity`
    );
  }
  assertUtcDateTime(suggestion.proposedAt, child(path, 'proposedAt'));
  if (Object.hasOwn(suggestion, 'editedAt') && suggestion.editedAt !== null) {
    assertUtcDateTime(suggestion.editedAt, child(path, 'editedAt'));
  }
}

function assertDatasetAccessMap(value, path) {
  const datasets = assertRecord(value, path);
  for (const [datasetId, entryValue] of Object.entries(datasets)) {
    assertExactNonblank(datasetId, `${path} key`);
    const entryPath = child(path, datasetId);
    const entry = assertExactFields(
      entryValue,
      entryPath,
      ['fieldsToAnnotate', 'lastAccessedAt']
    );
    const fields = assertArray(
      entry.fieldsToAnnotate,
      child(entryPath, 'fieldsToAnnotate')
    );
    fields.forEach((field, index) => {
      assertFieldKey(
        field,
        `${child(entryPath, 'fieldsToAnnotate')}[${index}]`
      );
    });
    assertUniqueStrings(fields, child(entryPath, 'fieldsToAnnotate'));
    assertUtcDateTime(entry.lastAccessedAt, child(entryPath, 'lastAccessedAt'));
  }
}

/**
 * Validate one dataset view of a user file (version 1 of its own): the
 * profile and one dataset's access record, suggestions, votes, comments and
 * deletion markers.
 *
 * @param {unknown} value
 * @param {{path?: string, filename?: string|null}} [options]
 * @returns {object}
 */
export function assertUserDocument(value, { path = '$', filename = null } = {}) {
  const document = assertExactFields(
    value,
    path,
    ['version', 'username', 'githubUserId', 'updatedAt', 'suggestions', 'votes'],
    [
      'login',
      'displayName',
      'title',
      'orcid',
      'linkedin',
      'datasets',
      'comments',
      'deletedSuggestions',
    ]
  );
  if (document.version !== DATASET_VIEW_VERSION) {
    reject(child(path, 'version'), `must equal ${DATASET_VIEW_VERSION}`);
  }
  const githubUserId = assertInteger(document.githubUserId, child(path, 'githubUserId'), {
    min: 1,
  });
  const expectedUser = `ghid_${githubUserId}`;
  const username = assertGhid(document.username, child(path, 'username'));
  if (username !== expectedUser) {
    reject(child(path, 'username'), `must equal ${JSON.stringify(expectedUser)}`);
  }
  if (filename !== null && filename !== `${expectedUser}.json`) {
    reject(path, `filename must be exactly ${JSON.stringify(`${expectedUser}.json`)}`);
  }
  for (const field of ['login', 'displayName', 'title', 'orcid', 'linkedin']) {
    if (!Object.hasOwn(document, field)) continue;
    assertExactNonblank(document[field], child(path, field));
  }
  if (Object.hasOwn(document, 'orcid') && !isExactOrcidId(document.orcid)) {
    reject(child(path, 'orcid'), 'must be an exact checksum-valid ORCID iD');
  }
  if (Object.hasOwn(document, 'linkedin') && !isExactLinkedInHandle(document.linkedin)) {
    reject(child(path, 'linkedin'), 'has an invalid format');
  }
  assertUtcDateTime(document.updatedAt, child(path, 'updatedAt'));
  if (Object.hasOwn(document, 'datasets')) {
    assertDatasetAccessMap(document.datasets, child(path, 'datasets'));
  }

  const suggestionIds = new Set();
  const suggestionsPath = child(path, 'suggestions');
  const suggestions = assertRecord(document.suggestions, suggestionsPath);
  for (const [bucket, listValue] of Object.entries(suggestions)) {
    assertBucket(bucket, `${suggestionsPath} key`);
    const listPath = child(suggestionsPath, bucket);
    const list = assertArray(listValue, listPath);
    list.forEach((suggestion, index) => {
      assertSuggestion(suggestion, `${listPath}[${index}]`, username, suggestionIds);
    });
  }

  const votesPath = child(path, 'votes');
  const votes = assertRecord(document.votes, votesPath);
  for (const [suggestionId, direction] of Object.entries(votes)) {
    assertSuggestionId(suggestionId, `${votesPath} key`);
    if (direction !== 'up' && direction !== 'down') {
      reject(child(votesPath, suggestionId), 'must equal "up" or "down"');
    }
  }

  if (Object.hasOwn(document, 'comments')) {
    const commentsPath = child(path, 'comments');
    const comments = assertRecord(document.comments, commentsPath);
    for (const [suggestionId, listValue] of Object.entries(comments)) {
      assertSuggestionId(suggestionId, `${commentsPath} key`);
      const listPath = child(commentsPath, suggestionId);
      const list = assertArray(listValue, listPath);
      const commentIds = new Set();
      list.forEach((commentValue, index) => {
        const commentPath = `${listPath}[${index}]`;
        const comment = assertExactFields(
          commentValue,
          commentPath,
          ['id', 'text', 'authorUsername', 'createdAt'],
          ['editedAt']
        );
        const id = assertExactNonblank(comment.id, child(commentPath, 'id'));
        if (commentIds.has(id)) reject(child(commentPath, 'id'), 'must be unique');
        commentIds.add(id);
        assertExactNonblank(comment.text, child(commentPath, 'text'));
        const author = assertGhid(
          comment.authorUsername,
          child(commentPath, 'authorUsername')
        );
        if (author !== username) {
          reject(
            child(commentPath, 'authorUsername'),
            `must equal file identity ${JSON.stringify(username)}`
          );
        }
        assertUtcDateTime(comment.createdAt, child(commentPath, 'createdAt'));
        if (Object.hasOwn(comment, 'editedAt') && comment.editedAt !== null) {
          assertUtcDateTime(comment.editedAt, child(commentPath, 'editedAt'));
        }
      });
    }
  }

  if (Object.hasOwn(document, 'deletedSuggestions')) {
    const deletedPath = child(path, 'deletedSuggestions');
    const deleted = assertRecord(document.deletedSuggestions, deletedPath);
    for (const [bucket, idsValue] of Object.entries(deleted)) {
      assertBucket(bucket, `${deletedPath} key`);
      const idsPath = child(deletedPath, bucket);
      const ids = assertArray(idsValue, idsPath);
      ids.forEach((id, index) => {
        const idPath = `${idsPath}[${index}]`;
        if (assertSuggestionId(id, idPath) !== username) {
          reject(
            idPath,
            `must name a suggestion of the file owner (start with ${JSON.stringify(`${username}_`)})`
          );
        }
      });
      assertUniqueStrings(ids, idsPath);
    }
  }
  return document;
}

export function assertConfigDocument(value, { path = '$' } = {}) {
  const document = assertExactFields(value, path, ['version', 'supportedDatasets']);
  if (document.version !== ANNOTATION_CONFIG_FILE_VERSION) {
    reject(child(path, 'version'), `must equal ${ANNOTATION_CONFIG_FILE_VERSION}`);
  }
  const entries = assertArray(
    document.supportedDatasets,
    child(path, 'supportedDatasets'),
    { min: 1 }
  );
  const datasetIds = new Set();
  entries.forEach((entryValue, index) => {
    const entryPath = `${child(path, 'supportedDatasets')}[${index}]`;
    const entry = assertExactFields(entryValue, entryPath, [
      'datasetId',
      'name',
      'fieldsToAnnotate',
      'annotatableSettings',
      'closedFields',
    ]);
    const datasetId = assertExactNonblank(entry.datasetId, child(entryPath, 'datasetId'));
    if (datasetIds.has(datasetId)) {
      reject(child(entryPath, 'datasetId'), 'must be unique');
    }
    datasetIds.add(datasetId);
    assertExactNonblank(entry.name, child(entryPath, 'name'));
    const fieldsPath = child(entryPath, 'fieldsToAnnotate');
    const fields = assertArray(entry.fieldsToAnnotate, fieldsPath, { min: 1 });
    fields.forEach((field, fieldIndex) => {
      assertFieldKey(field, `${fieldsPath}[${fieldIndex}]`);
    });
    assertUniqueStrings(fields, fieldsPath);
    const fieldSet = new Set(fields);

    const settingsPath = child(entryPath, 'annotatableSettings');
    const settings = assertRecord(
      entry.annotatableSettings,
      settingsPath
    );
    for (const field of fields) {
      if (!Object.hasOwn(settings, field)) {
        reject(settingsPath, `missing settings for field ${JSON.stringify(field)}`);
      }
    }
    for (const [field, raw] of Object.entries(settings)) {
      assertFieldKey(field, `${settingsPath} key`);
      if (!fieldSet.has(field)) {
        reject(settingsPath, `contains unknown field ${JSON.stringify(field)}`);
      }
      const settingPath = child(settingsPath, field);
      const setting = assertExactFields(raw, settingPath, [
        'minAnnotators',
        'threshold',
      ]);
      assertInteger(setting.minAnnotators, child(settingPath, 'minAnnotators'), {
        min: 0,
      });
      assertNumber(setting.threshold, child(settingPath, 'threshold'), {
        min: -1,
        max: 1,
      });
    }

    const closedPath = child(entryPath, 'closedFields');
    const closed = assertArray(entry.closedFields, closedPath);
    closed.forEach((field, fieldIndex) => {
      assertFieldKey(field, `${closedPath}[${fieldIndex}]`);
      if (!fieldSet.has(field)) {
        reject(`${closedPath}[${fieldIndex}]`, 'must also appear in fieldsToAnnotate');
      }
    });
    assertUniqueStrings(closed, closedPath);
  });
  return document;
}

/**
 * Validate one dataset view of the merges file (version 1 of its own): that
 * dataset's merges, without their dataset id.
 *
 * @param {unknown} value
 * @param {{path?: string}} [options]
 * @returns {object}
 */
export function assertMergesDocument(value, { path = '$' } = {}) {
  const document = assertExactFields(value, path, ['version', 'updatedAt', 'merges']);
  if (document.version !== DATASET_VIEW_VERSION) {
    reject(child(path, 'version'), `must equal ${DATASET_VIEW_VERSION}`);
  }
  assertUtcDateTime(document.updatedAt, child(path, 'updatedAt'));
  const merges = assertArray(document.merges, child(path, 'merges'));
  const byBucketFrom = new Set();
  const edgesByBucket = new Map();
  merges.forEach((value, index) => {
    const mergePath = `${child(path, 'merges')}[${index}]`;
    const merge = assertExactFields(
      value,
      mergePath,
      ['bucket', 'fromSuggestionId', 'intoSuggestionId', 'by', 'at'],
      ['note', 'editedAt']
    );
    const bucket = assertBucket(merge.bucket, child(mergePath, 'bucket'));
    assertSuggestionId(merge.fromSuggestionId, child(mergePath, 'fromSuggestionId'));
    assertSuggestionId(merge.intoSuggestionId, child(mergePath, 'intoSuggestionId'));
    const from = merge.fromSuggestionId;
    const into = merge.intoSuggestionId;
    if (from === into) {
      reject(mergePath, 'fromSuggestionId and intoSuggestionId must differ');
    }
    const key = `${bucket}\u0000${from}`;
    if (byBucketFrom.has(key)) {
      reject(mergePath, 'duplicates an existing bucket/fromSuggestionId mapping');
    }
    byBucketFrom.add(key);
    if (!edgesByBucket.has(bucket)) edgesByBucket.set(bucket, new Map());
    edgesByBucket.get(bucket).set(from, into);
    assertGhid(merge.by, child(mergePath, 'by'));
    assertUtcDateTime(merge.at, child(mergePath, 'at'));
    if (Object.hasOwn(merge, 'note')) {
      assertNullableExactNonblank(merge.note, child(mergePath, 'note'));
    }
    if (Object.hasOwn(merge, 'editedAt') && merge.editedAt !== null) {
      assertUtcDateTime(merge.editedAt, child(mergePath, 'editedAt'));
    }
  });
  for (const [bucket, edges] of edgesByBucket) {
    for (const start of edges.keys()) {
      const seen = new Set([start]);
      let current = start;
      while (edges.has(current)) {
        current = edges.get(current);
        if (seen.has(current)) {
          reject(child(path, 'merges'), `contains a cycle in bucket ${JSON.stringify(bucket)}`);
        }
        seen.add(current);
      }
    }
  }
  return document;
}

const USER_FILE_PROFILE_FIELDS = Object.freeze([
  'login',
  'displayName',
  'title',
  'orcid',
  'linkedin',
]);

const USER_SECTION_REQUIRED_FIELDS = Object.freeze([
  'fieldsToAnnotate',
  'lastAccessedAt',
  'suggestions',
  'votes',
]);

const USER_SECTION_OPTIONAL_FIELDS = Object.freeze([
  'comments',
  'deletedSuggestions',
]);

const USER_SECTION_CONTENT_FIELDS = Object.freeze([
  'suggestions',
  'votes',
  'comments',
  'deletedSuggestions',
]);

/**
 * The dataset view of one section of a user file. The view copies the
 * section's content (`clone`) when it is handed to the app, and shares it
 * when it is only validated.
 *
 * @param {object} file - A user file whose top level is checked
 * @param {string|null} datasetId
 * @param {object|null} section - A section whose fields are checked
 * @param {{clone: boolean}} options
 * @returns {object}
 */
function userViewOf(file, datasetId, section, { clone }) {
  const copy = clone ? structuredClone : (value) => value;
  const view = {
    version: DATASET_VIEW_VERSION,
    username: file.username,
    githubUserId: file.githubUserId,
    updatedAt: file.updatedAt,
  };
  for (const field of USER_FILE_PROFILE_FIELDS) {
    if (Object.hasOwn(file, field)) view[field] = file[field];
  }
  if (section !== null) {
    view.datasets = {
      [datasetId]: {
        fieldsToAnnotate: clone ? [...section.fieldsToAnnotate] : section.fieldsToAnnotate,
        lastAccessedAt: section.lastAccessedAt,
      },
    };
  }
  view.suggestions = section === null ? {} : copy(section.suggestions);
  view.votes = section === null ? {} : copy(section.votes);
  if (section !== null && Object.hasOwn(section, 'comments')) {
    view.comments = copy(section.comments);
  }
  if (section !== null && Object.hasOwn(section, 'deletedSuggestions')) {
    view.deletedSuggestions = copy(section.deletedSuggestions);
  }
  return view;
}

/** The top level of a user file: its fields, version and profile. */
function assertUserFileProfile(value, path, filename) {
  const file = assertExactFields(
    value,
    path,
    ['version', 'username', 'githubUserId', 'updatedAt', 'datasets'],
    USER_FILE_PROFILE_FIELDS
  );
  if (file.version !== ANNOTATION_USER_FILE_VERSION) {
    reject(child(path, 'version'), `must equal ${ANNOTATION_USER_FILE_VERSION}`);
  }
  assertRecord(file.datasets, child(path, 'datasets'));
  // The profile alone is a dataset view without a section.
  assertUserDocument(userViewOf(file, null, null, { clone: false }), { path, filename });
  return file;
}

function assertUserSection(file, datasetId, path, filename) {
  const sectionPath = child(child(path, 'datasets'), datasetId);
  const section = assertExactFields(
    file.datasets[datasetId],
    sectionPath,
    USER_SECTION_REQUIRED_FIELDS,
    USER_SECTION_OPTIONAL_FIELDS
  );
  // A section is a complete dataset view of its own; validating that view
  // checks the section with the rules the app applies to it.
  assertUserDocument(userViewOf(file, datasetId, section, { clone: false }), {
    path: sectionPath,
    filename,
  });
  return section;
}

/**
 * Validate one whole user file (`annotations/users/ghid_<id>.json`,
 * version 3): the profile and every dataset's section. The app checks a whole
 * file before it publishes the contributor's own file.
 *
 * @param {unknown} value
 * @param {{path?: string, filename?: string|null}} [options]
 * @returns {object}
 */
export function assertUserFile(value, { path = '$', filename = null } = {}) {
  const file = assertUserFileProfile(value, path, filename);
  for (const datasetId of Object.keys(file.datasets)) {
    assertExactNonblank(datasetId, `${child(path, 'datasets')} key`);
    assertUserSection(file, datasetId, path, filename);
  }
  return file;
}

/**
 * The open dataset's view of one user file: the profile, and that dataset's
 * suggestions, votes, comments and deletion markers (empty when the
 * contributor has none for it). Only the profile and that section are
 * validated: another dataset's section is not this dataset's business, so a
 * file can be read here whatever it holds for other datasets.
 *
 * @param {unknown} value - A user file
 * @param {string} datasetId
 * @param {{path?: string, filename?: string|null}} [options]
 * @returns {object} A dataset view (`assertUserDocument`)
 */
export function projectUserFile(value, datasetId, { path = '$', filename = null } = {}) {
  assertExactNonblank(datasetId, `${path} dataset`);
  const file = assertUserFileProfile(value, path, filename);
  const section = Object.hasOwn(file.datasets, datasetId)
    ? assertUserSection(file, datasetId, path, filename)
    : null;
  return userViewOf(file, datasetId, section, { clone: true });
}

/**
 * Compose a user file from the open dataset's view: the view replaces that
 * dataset's section and the profile; every other dataset's section of the
 * file already published is kept as it is.
 *
 * @param {unknown|null} previous - The published file, or null for a new one
 * @param {string} datasetId
 * @param {unknown} view - The dataset view to publish
 * @param {{path?: string, filename?: string|null}} [options]
 * @returns {object} A user file (`assertUserFile`)
 */
export function composeUserFile(previous, datasetId, view, { path = '$', filename = null } = {}) {
  const prior = previous === null ? null : assertUserFile(previous, { path, filename });
  const current = assertUserDocument(view, { path, filename });
  assertExactNonblank(datasetId, `${path} dataset`);
  if (prior !== null && prior.githubUserId !== current.githubUserId) {
    reject(path, 'must belong to the same contributor as the published file');
  }
  const access = current.datasets && Object.hasOwn(current.datasets, datasetId)
    ? current.datasets[datasetId]
    : prior !== null && Object.hasOwn(prior.datasets, datasetId)
      ? prior.datasets[datasetId]
      : { fieldsToAnnotate: [], lastAccessedAt: current.updatedAt };
  const section = {
    fieldsToAnnotate: [...access.fieldsToAnnotate],
    lastAccessedAt: access.lastAccessedAt,
  };
  for (const field of USER_SECTION_CONTENT_FIELDS) {
    if (Object.hasOwn(current, field)) section[field] = structuredClone(current[field]);
  }
  const datasets = {};
  for (const [id, entry] of Object.entries(prior?.datasets ?? {})) {
    if (id !== datasetId) datasets[id] = structuredClone(entry);
  }
  datasets[datasetId] = section;
  const file = {
    version: ANNOTATION_USER_FILE_VERSION,
    username: current.username,
    githubUserId: current.githubUserId,
    updatedAt: current.updatedAt,
  };
  for (const field of USER_FILE_PROFILE_FIELDS) {
    if (Object.hasOwn(current, field)) file[field] = current[field];
  }
  file.datasets = datasets;
  return assertUserFile(file, { path, filename });
}

/** The top level of the merges file: its fields, version and time. */
function assertMergesFileTop(value, path) {
  const file = assertExactFields(value, path, ['version', 'updatedAt', 'merges']);
  if (file.version !== ANNOTATION_MERGES_FILE_VERSION) {
    reject(child(path, 'version'), `must equal ${ANNOTATION_MERGES_FILE_VERSION}`);
  }
  assertUtcDateTime(file.updatedAt, child(path, 'updatedAt'));
  assertArray(file.merges, child(path, 'merges'));
  return file;
}

function mergesViewOf(file, merges, { clone }) {
  return {
    version: DATASET_VIEW_VERSION,
    updatedAt: file.updatedAt,
    merges: merges.map(({ datasetId: _datasetId, ...merge }) =>
      clone ? structuredClone(merge) : merge
    ),
  };
}

/**
 * Validate the whole merges file (`annotations/moderation/merges.json`,
 * version 3): every merge names its dataset, and the merges of each dataset
 * form a valid merges view of their own.
 *
 * @param {unknown} value
 * @param {{path?: string}} [options]
 * @returns {object}
 */
export function assertMergesFile(value, { path = '$' } = {}) {
  const file = assertMergesFileTop(value, path);
  const byDataset = new Map();
  file.merges.forEach((merge, index) => {
    const mergePath = `${child(path, 'merges')}[${index}]`;
    assertRecord(merge, mergePath);
    const datasetId = assertExactNonblank(merge.datasetId, child(mergePath, 'datasetId'));
    if (!byDataset.has(datasetId)) byDataset.set(datasetId, []);
    byDataset.get(datasetId).push(merge);
  });
  for (const [datasetId, list] of byDataset) {
    assertMergesDocument(
      mergesViewOf(file, list, { clone: false }),
      { path: `${path} dataset ${JSON.stringify(datasetId)}` }
    );
  }
  return file;
}

/**
 * The open dataset's view of the merges file: its merges, without the
 * dataset id. Only the file's top level and that dataset's merges are
 * validated; another dataset's merges are not this dataset's business.
 *
 * @param {unknown} value
 * @param {string} datasetId
 * @param {{path?: string}} [options]
 * @returns {object} A merges view (`assertMergesDocument`)
 */
export function projectMergesFile(value, datasetId, { path = '$' } = {}) {
  assertExactNonblank(datasetId, `${path} dataset`);
  const file = assertMergesFileTop(value, path);
  const own = file.merges.filter(
    (merge) => isRecord(merge) && merge.datasetId === datasetId
  );
  return assertMergesDocument(mergesViewOf(file, own, { clone: true }), {
    path: `${path} dataset ${JSON.stringify(datasetId)}`,
  });
}

/**
 * Compose the merges file from the open dataset's view, keeping every other
 * dataset's merges as published.
 *
 * @param {unknown|null} previous
 * @param {string} datasetId
 * @param {unknown} view
 * @param {{path?: string}} [options]
 * @returns {object} A merges file (`assertMergesFile`)
 */
export function composeMergesFile(previous, datasetId, view, { path = '$' } = {}) {
  const prior = previous === null ? null : assertMergesFile(previous, { path });
  const current = assertMergesDocument(view, { path });
  assertExactNonblank(datasetId, `${path} dataset`);
  const merges = [
    ...(prior?.merges ?? [])
      .filter(merge => merge.datasetId !== datasetId)
      .map(merge => structuredClone(merge)),
    ...current.merges.map(merge => ({ datasetId, ...structuredClone(merge) })),
  ];
  return assertMergesFile(
    { version: ANNOTATION_MERGES_FILE_VERSION, updatedAt: current.updatedAt, merges },
    { path }
  );
}
