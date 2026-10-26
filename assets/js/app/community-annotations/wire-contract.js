/**
 * Exact current wire contract for community annotation repositories.
 *
 * These validators accept JSON values without rewriting them. Callers must
 * validate before publishing, caching, or mutating session state.
 */

import { isExactOrcidId } from './profile-identifiers.js';

export const ANNOTATION_CONTRACT_IDS = Object.freeze({
  user: 'https://cellucid.com/contracts/community-annotation/user-v2.schema.json',
  config: 'https://cellucid.com/contracts/community-annotation/config-v1.schema.json',
  merges: 'https://cellucid.com/contracts/community-annotation/merges-v2.schema.json',
});

/*
 * Files and dataset views.
 *
 * A repository can annotate several datasets, and two datasets can share a
 * field and a category label ("leiden" / "0"), so everything a contributor
 * writes is kept per dataset:
 *
 * - a user file (version 2) holds the profile once and, under
 *   `datasets[<datasetId>]`, that dataset's access record, suggestions, votes,
 *   comments and deletion markers;
 * - the merges file (version 2) names the dataset of every merge.
 *
 * The app works on one dataset at a time, so `github-sync.js` projects each
 * file onto the open dataset (a *dataset view*: the shape `assertUserDocument`
 * and `assertMergesDocument` validate) when it pulls, and composes the file
 * back from the view when it publishes, replacing only that dataset's part
 * and keeping every other dataset's part byte for byte. Nothing else in the
 * app reads or writes the file shapes.
 */

// GitHub's repository Contents API supports its complete JSON/base64 contract
// only for files whose decoded content is at most 1 MB. Keep this as one shared
// browser/Worker boundary so publication and remote reconciliation cannot drift.
export const ANNOTATION_FILE_MAX_UTF8_BYTES = 1_000_000;

/**
 * Lengths of the text a contributor types, as the annotation schema states
 * them. Counts (datasets, fields, suggestions, votes, comments, merges) and the
 * keys the exporters write (field keys, `field:category` buckets) have no
 * limit of their own: the 1,000,000-byte file is the only bound on how much
 * one contributor file holds.
 */
export const ANNOTATION_LIMITS = Object.freeze({
  githubUserId: Number.MAX_SAFE_INTEGER,
  username: 64,
  login: 64,
  displayName: 120,
  title: 120,
  orcid: 64,
  linkedin: 120,
  datasetId: 256,
  datasetName: 120,
  suggestionId: 128,
  label: 120,
  ontologyId: 64,
  evidence: 2000,
  markerGene: 64,
  commentId: 128,
  commentText: 500,
  mergeNote: 512,
});

const UTC_DATE_TIME =
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})T(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})(?:\.(?<millisecond>[0-9]{3}))?Z$/;
const GHID = /^ghid_[1-9][0-9]*$/;
const LINKEDIN = /^[a-z0-9-]{3,120}$/;

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
  if (
    typeof path !== 'string' ||
    !path ||
    /^\s|\s$/.test(path)
  ) {
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

function assertString(
  value,
  path,
  { min = 1, max, pattern = null, nullable = false } = {}
) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') reject(path, 'must be a JSON string');
  const length = Array.from(value).length;
  if (length < min) reject(path, `must contain at least ${min} character(s)`);
  if (max !== undefined && length > max) {
    reject(path, `must contain at most ${max} character(s)`);
  }
  if (pattern && !pattern.test(value)) reject(path, 'has an invalid format');
  return value;
}

function assertNonblankString(value, path, max) {
  const string = assertString(value, path, { max });
  if (!/\S/.test(string)) reject(path, 'must be nonblank');
  if (/^\s|\s$/.test(string)) reject(path, 'must not have leading or trailing whitespace');
  return string;
}

function assertFieldKey(value, path) {
  const field = assertNonblankString(value, path);
  if (isReservedAnnotationFieldKey(field)) {
    reject(
      path,
      'uses the reserved fk~...%3A field-key encoding form'
    );
  }
  return field;
}

function assertSuggestionId(value, path) {
  const id = assertNonblankString(
    value,
    path,
    ANNOTATION_LIMITS.suggestionId
  );
  if (hasAnnotationSuggestionIdDelimiter(id)) {
    reject(path, 'suggestion identifiers must not contain the ":" delimiter');
  }
  return id;
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

function assertArray(value, path, { min = 0, max } = {}) {
  if (!Array.isArray(value)) reject(path, 'must be a JSON array');
  if (value.length < min) reject(path, `must contain at least ${min} item(s)`);
  if (max !== undefined && value.length > max) {
    reject(path, `must contain at most ${max} item(s)`);
  }
  return value;
}

function assertUniqueStrings(values, path) {
  const seen = new Set();
  values.forEach((value, index) => {
    if (seen.has(value)) reject(`${path}[${index}]`, 'duplicates an earlier item');
    seen.add(value);
  });
}

/**
 * Parse JSON while rejecting duplicate object keys.
 *
 * Native JSON.parse keeps the last duplicate key, which would make the browser
 * contract weaker than the repository validator. This syntax pass decodes each
 * object key before comparison, so `"name"` and `"\u006eame"` are duplicates.
 */
export function parseExactJson(text, { path = '$' } = {}) {
  if (typeof text !== 'string') reject(path, 'JSON input must be a string');

  let index = 0;
  const length = text.length;
  const syntax = (message) => reject(`${path} at character ${index}`, message);
  const skipWhitespace = () => {
    while (
      index < length &&
      (text[index] === ' ' ||
        text[index] === '\n' ||
        text[index] === '\r' ||
        text[index] === '\t')
    ) {
      index += 1;
    }
  };

  const parseStringToken = () => {
    if (text[index] !== '"') syntax('expected a JSON string');
    const start = index;
    index += 1;
    while (index < length) {
      const code = text.charCodeAt(index);
      const char = text[index];
      if (char === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          syntax('invalid JSON string');
        }
      }
      if (code < 0x20) syntax('unescaped control character in JSON string');
      if (char !== '\\') {
        index += 1;
        continue;
      }
      index += 1;
      if (index >= length) syntax('unterminated JSON string escape');
      const escape = text[index];
      if ('"\\/bfnrt'.includes(escape)) {
        index += 1;
        continue;
      }
      if (escape !== 'u') syntax('invalid JSON string escape');
      const hex = text.slice(index + 1, index + 5);
      if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
        syntax('invalid JSON Unicode escape');
      }
      index += 5;
    }
    syntax('unterminated JSON string');
  };

  const parseValue = (depth) => {
    if (depth > 512) syntax('JSON nesting exceeds 512 levels');
    skipWhitespace();
    if (index >= length) syntax('expected a JSON value');
    const char = text[index];

    if (char === '"') {
      parseStringToken();
      return;
    }
    if (char === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (true) {
        skipWhitespace();
        const key = parseStringToken();
        if (keys.has(key)) {
          syntax(`duplicate JSON object key ${JSON.stringify(key)}`);
        }
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') syntax('expected ":" after JSON object key');
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') syntax('expected "," or "}" in JSON object');
        index += 1;
      }
    }
    if (char === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (true) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') syntax('expected "," or "]" in JSON array');
        index += 1;
      }
    }
    if (text.startsWith('true', index)) {
      index += 4;
      return;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return;
    }
    const number = text
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) syntax('invalid JSON value');
    index += number[0].length;
  };

  skipWhitespace();
  parseValue(0);
  skipWhitespace();
  if (index !== length) syntax('unexpected content after the JSON value');
  try {
    return JSON.parse(text);
  } catch {
    syntax('invalid JSON');
  }
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
  return assertString(value, path, {
    max: ANNOTATION_LIMITS.username,
    pattern: GHID,
  });
}

function assertBucket(value, path) {
  const bucket = assertNonblankString(value, path);
  const delimiter = bucket.indexOf(':');
  if (delimiter <= 0 || delimiter === bucket.length - 1) {
    reject(path, 'must have <fieldKey>:<categoryLabel> form');
  }
  const field = bucket.slice(0, delimiter);
  const category = bucket.slice(delimiter + 1);
  if (
    !/\S/.test(field) ||
    !/\S/.test(category) ||
    /^\s|\s$/.test(field) ||
    /^\s|\s$/.test(category)
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
  const id = assertSuggestionId(suggestion.id, child(path, 'id'));
  if (suggestionIds.has(id)) reject(child(path, 'id'), 'must be globally unique');
  suggestionIds.add(id);
  assertNonblankString(
    suggestion.label,
    child(path, 'label'),
    ANNOTATION_LIMITS.label
  );
  if (Object.hasOwn(suggestion, 'ontologyId')) {
    assertString(suggestion.ontologyId, child(path, 'ontologyId'), {
      min: suggestion.ontologyId === null ? 0 : 1,
      max: ANNOTATION_LIMITS.ontologyId,
      nullable: true,
    });
    if (typeof suggestion.ontologyId === 'string' && !/\S/.test(suggestion.ontologyId)) {
      reject(child(path, 'ontologyId'), 'must be nonblank or null');
    }
    if (typeof suggestion.ontologyId === 'string' && /^\s|\s$/.test(suggestion.ontologyId)) {
      reject(child(path, 'ontologyId'), 'must not have leading or trailing whitespace');
    }
  }
  if (Object.hasOwn(suggestion, 'evidence')) {
    assertString(suggestion.evidence, child(path, 'evidence'), {
      min: suggestion.evidence === null ? 0 : 1,
      max: ANNOTATION_LIMITS.evidence,
      nullable: true,
    });
    if (typeof suggestion.evidence === 'string' && !/\S/.test(suggestion.evidence)) {
      reject(child(path, 'evidence'), 'must be nonblank or null');
    }
    if (typeof suggestion.evidence === 'string' && /^\s|\s$/.test(suggestion.evidence)) {
      reject(child(path, 'evidence'), 'must not have leading or trailing whitespace');
    }
  }
  if (Object.hasOwn(suggestion, 'markers') && suggestion.markers !== null) {
    const markers = assertArray(suggestion.markers, child(path, 'markers'));
    markers.forEach((marker, index) => {
      const markerPath = `${child(path, 'markers')}[${index}]`;
      if (typeof marker === 'string') {
        assertNonblankString(marker, markerPath, ANNOTATION_LIMITS.markerGene);
        return;
      }
      const record = assertExactFields(marker, markerPath, ['gene'], ['logFC', 'pval']);
      assertNonblankString(
        record.gene,
        child(markerPath, 'gene'),
        ANNOTATION_LIMITS.markerGene
      );
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
  assertUtcDateTime(suggestion.proposedAt, child(path, 'proposedAt'));
  if (Object.hasOwn(suggestion, 'editedAt') && suggestion.editedAt !== null) {
    assertUtcDateTime(suggestion.editedAt, child(path, 'editedAt'));
  }
}

function assertDatasetAccessMap(value, path) {
  const datasets = assertRecord(value, path);
  for (const [datasetId, entryValue] of Object.entries(datasets)) {
    assertNonblankString(datasetId, `${path} key`, ANNOTATION_LIMITS.datasetId);
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
  if (document.version !== 1) reject(child(path, 'version'), 'must equal 1');
  const githubUserId = assertInteger(document.githubUserId, child(path, 'githubUserId'), {
    min: 1,
    max: ANNOTATION_LIMITS.githubUserId,
  });
  const expectedUser = `ghid_${githubUserId}`;
  const username = assertGhid(document.username, child(path, 'username'));
  if (username !== expectedUser) {
    reject(child(path, 'username'), `must equal ${JSON.stringify(expectedUser)}`);
  }
  if (filename !== null && filename !== `${expectedUser}.json`) {
    reject(path, `filename must be exactly ${JSON.stringify(`${expectedUser}.json`)}`);
  }
  const optionalStrings = [
    ['login', ANNOTATION_LIMITS.login, null],
    ['displayName', ANNOTATION_LIMITS.displayName, null],
    ['title', ANNOTATION_LIMITS.title, null],
    ['orcid', ANNOTATION_LIMITS.orcid, null],
    ['linkedin', ANNOTATION_LIMITS.linkedin, LINKEDIN],
  ];
  for (const [field, max, pattern] of optionalStrings) {
    if (!Object.hasOwn(document, field)) continue;
    assertNonblankString(document[field], child(path, field), max);
    if (pattern && !pattern.test(document[field])) {
      reject(child(path, field), 'has an invalid format');
    }
    if (field === 'orcid' && !isExactOrcidId(document[field])) {
      reject(child(path, field), 'must be an exact checksum-valid ORCID iD');
    }
  }
  assertUtcDateTime(document.updatedAt, child(path, 'updatedAt'));
  if (Object.hasOwn(document, 'datasets')) {
    assertDatasetAccessMap(document.datasets, child(path, 'datasets'));
  }

  const suggestionIds = new Set();
  const suggestions = assertRecord(
    document.suggestions,
    child(path, 'suggestions')
  );
  for (const [bucket, listValue] of Object.entries(suggestions)) {
    assertBucket(bucket, `${child(path, 'suggestions')} key`);
    const listPath = child(child(path, 'suggestions'), bucket);
    const list = assertArray(listValue, listPath, {
      max: ANNOTATION_LIMITS.suggestionsPerBucket,
    });
    list.forEach((suggestion, index) => {
      assertSuggestion(suggestion, `${listPath}[${index}]`, username, suggestionIds);
    });
  }

  const votes = assertRecord(
    document.votes,
    child(path, 'votes')
  );
  for (const [suggestionId, direction] of Object.entries(votes)) {
    assertSuggestionId(suggestionId, `${child(path, 'votes')} key`);
    if (direction !== 'up' && direction !== 'down') {
      reject(child(child(path, 'votes'), suggestionId), 'must equal "up" or "down"');
    }
  }

  if (Object.hasOwn(document, 'comments')) {
    const comments = assertRecord(
      document.comments,
      child(path, 'comments')
    );
    for (const [suggestionId, listValue] of Object.entries(comments)) {
      assertSuggestionId(suggestionId, `${child(path, 'comments')} key`);
      const listPath = child(child(path, 'comments'), suggestionId);
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
        const id = assertNonblankString(
          comment.id,
          child(commentPath, 'id'),
          ANNOTATION_LIMITS.commentId
        );
        if (commentIds.has(id)) reject(child(commentPath, 'id'), 'must be unique');
        commentIds.add(id);
        assertNonblankString(
          comment.text,
          child(commentPath, 'text'),
          ANNOTATION_LIMITS.commentText
        );
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
    const deleted = assertRecord(
      document.deletedSuggestions,
      child(path, 'deletedSuggestions')
    );
    for (const [bucket, idsValue] of Object.entries(deleted)) {
      assertBucket(bucket, `${child(path, 'deletedSuggestions')} key`);
      const idsPath = child(child(path, 'deletedSuggestions'), bucket);
      const ids = assertArray(idsValue, idsPath);
      ids.forEach((id, index) => {
        assertSuggestionId(id, `${idsPath}[${index}]`);
      });
      assertUniqueStrings(ids, idsPath);
    }
  }
  return document;
}

export function assertConfigDocument(value, { path = '$' } = {}) {
  const document = assertExactFields(value, path, ['version', 'supportedDatasets']);
  if (document.version !== 1) reject(child(path, 'version'), 'must equal 1');
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
    const datasetId = assertNonblankString(
      entry.datasetId,
      child(entryPath, 'datasetId'),
      ANNOTATION_LIMITS.datasetId
    );
    if (datasetIds.has(datasetId)) {
      reject(child(entryPath, 'datasetId'), 'must be unique');
    }
    datasetIds.add(datasetId);
    assertNonblankString(
      entry.name,
      child(entryPath, 'name'),
      ANNOTATION_LIMITS.datasetName
    );
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

export function assertMergesDocument(value, { path = '$' } = {}) {
  const document = assertExactFields(value, path, ['version', 'updatedAt', 'merges']);
  if (document.version !== 1) reject(child(path, 'version'), 'must equal 1');
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
    const from = assertSuggestionId(
      merge.fromSuggestionId,
      child(mergePath, 'fromSuggestionId')
    );
    const into = assertSuggestionId(
      merge.intoSuggestionId,
      child(mergePath, 'intoSuggestionId')
    );
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
      assertString(merge.note, child(mergePath, 'note'), {
        min: merge.note === null ? 0 : 1,
        max: ANNOTATION_LIMITS.mergeNote,
        nullable: true,
      });
      if (typeof merge.note === 'string' && !/\S/.test(merge.note)) {
        reject(child(mergePath, 'note'), 'must be nonblank or null');
      }
      if (typeof merge.note === 'string' && /^\s|\s$/.test(merge.note)) {
        reject(child(mergePath, 'note'), 'must not have leading or trailing whitespace');
      }
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

export function assertSchemaIdentity(value, kind, { path = '$' } = {}) {
  const schema = assertRecord(value, path);
  const expectedId = ANNOTATION_CONTRACT_IDS[kind];
  if (!expectedId) reject(path, `unknown schema kind ${JSON.stringify(kind)}`);
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    reject(child(path, '$schema'), 'must declare JSON Schema draft 2020-12');
  }
  if (schema.$id !== expectedId) {
    reject(child(path, '$id'), `must equal ${JSON.stringify(expectedId)}`);
  }
  return schema;
}

const USER_FILE_PROFILE_FIELDS = Object.freeze([
  'login',
  'displayName',
  'title',
  'orcid',
  'linkedin',
]);

const USER_SECTION_CONTENT_FIELDS = Object.freeze([
  'suggestions',
  'votes',
  'comments',
  'deletedSuggestions',
]);

/**
 * The dataset view of one section of a user file.
 *
 * @param {object} file - A validated user file
 * @param {string} datasetId
 * @param {object|null} section
 * @returns {object}
 */
function userViewOf(file, datasetId, section) {
  const view = {
    version: 1,
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
        fieldsToAnnotate: [...section.fieldsToAnnotate],
        lastAccessedAt: section.lastAccessedAt,
      },
    };
  }
  view.suggestions = structuredClone(section?.suggestions ?? {});
  view.votes = structuredClone(section?.votes ?? {});
  if (section !== null && Object.hasOwn(section, 'comments')) {
    view.comments = structuredClone(section.comments);
  }
  if (section !== null && Object.hasOwn(section, 'deletedSuggestions')) {
    view.deletedSuggestions = structuredClone(section.deletedSuggestions);
  }
  return view;
}

/**
 * Validate one user file (`annotations/users/ghid_<id>.json`, version 2).
 *
 * @param {unknown} value
 * @param {{path?: string, filename?: string|null}} [options]
 * @returns {object}
 */
export function assertUserFile(value, { path = '$', filename = null } = {}) {
  const file = assertExactFields(
    value,
    path,
    ['version', 'username', 'githubUserId', 'updatedAt', 'datasets'],
    USER_FILE_PROFILE_FIELDS
  );
  if (file.version !== 2) reject(child(path, 'version'), 'must equal 2');
  const datasets = assertRecord(file.datasets, child(path, 'datasets'));
  for (const [datasetId, sectionValue] of Object.entries(datasets)) {
    assertNonblankString(datasetId, `${child(path, 'datasets')} key`, ANNOTATION_LIMITS.datasetId);
    const sectionPath = child(child(path, 'datasets'), datasetId);
    const section = assertExactFields(
      sectionValue,
      sectionPath,
      ['fieldsToAnnotate', 'lastAccessedAt', 'suggestions', 'votes'],
      ['comments', 'deletedSuggestions']
    );
    // Every section is a complete dataset view of its own; validating that
    // view checks the section with the rules the app applies to it.
    assertUserDocument(userViewOf(file, datasetId, section), {
      path: sectionPath,
      filename,
    });
  }
  if (Object.keys(datasets).length === 0) {
    // The profile alone still names its owner, which is what the validator
    // below proves; an empty file is a valid file.
    assertUserDocument(userViewOf(file, null, null), { path, filename });
  }
  return file;
}

/**
 * The open dataset's view of one user file: the profile, and that dataset's
 * suggestions, votes, comments and deletion markers (empty when the
 * contributor has none for it).
 *
 * @param {unknown} value - A user file
 * @param {string} datasetId
 * @param {{path?: string, filename?: string|null}} [options]
 * @returns {object} A dataset view (`assertUserDocument`)
 */
export function projectUserFile(value, datasetId, { path = '$', filename = null } = {}) {
  const file = assertUserFile(value, { path, filename });
  assertNonblankString(datasetId, `${path} dataset`, ANNOTATION_LIMITS.datasetId);
  const section = Object.hasOwn(file.datasets, datasetId) ? file.datasets[datasetId] : null;
  return assertUserDocument(userViewOf(file, datasetId, section), { path, filename });
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
  assertNonblankString(datasetId, `${path} dataset`, ANNOTATION_LIMITS.datasetId);
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
    version: 2,
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

/**
 * Validate the merges file (`annotations/moderation/merges.json`, version 2):
 * every merge names its dataset, and the merges of each dataset form a valid
 * merges view of their own.
 *
 * @param {unknown} value
 * @param {{path?: string}} [options]
 * @returns {object}
 */
export function assertMergesFile(value, { path = '$' } = {}) {
  const file = assertExactFields(value, path, ['version', 'updatedAt', 'merges']);
  if (file.version !== 2) reject(child(path, 'version'), 'must equal 2');
  assertUtcDateTime(file.updatedAt, child(path, 'updatedAt'));
  const merges = assertArray(file.merges, child(path, 'merges'));
  const byDataset = new Map();
  merges.forEach((value, index) => {
    const mergePath = `${child(path, 'merges')}[${index}]`;
    const merge = assertRecord(value, mergePath);
    const datasetId = assertNonblankString(
      merge.datasetId,
      child(mergePath, 'datasetId'),
      ANNOTATION_LIMITS.datasetId
    );
    const { datasetId: _datasetId, ...rest } = merge;
    if (!byDataset.has(datasetId)) byDataset.set(datasetId, []);
    byDataset.get(datasetId).push(rest);
  });
  for (const [datasetId, list] of byDataset) {
    assertMergesDocument(
      { version: 1, updatedAt: file.updatedAt, merges: list },
      { path: `${path} dataset ${JSON.stringify(datasetId)}` }
    );
  }
  return file;
}

/**
 * The open dataset's view of the merges file: its merges, without the
 * dataset name.
 *
 * @param {unknown} value
 * @param {string} datasetId
 * @param {{path?: string}} [options]
 * @returns {object} A merges view (`assertMergesDocument`)
 */
export function projectMergesFile(value, datasetId, { path = '$' } = {}) {
  const file = assertMergesFile(value, { path });
  const merges = file.merges
    .filter(merge => merge.datasetId === datasetId)
    .map(({ datasetId: _datasetId, ...merge }) => structuredClone(merge));
  return assertMergesDocument({ version: 1, updatedAt: file.updatedAt, merges }, { path });
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
  assertNonblankString(datasetId, `${path} dataset`, ANNOTATION_LIMITS.datasetId);
  const merges = [
    ...(prior?.merges ?? [])
      .filter(merge => merge.datasetId !== datasetId)
      .map(merge => structuredClone(merge)),
    ...current.merges.map(merge => ({ datasetId, ...structuredClone(merge) })),
  ];
  return assertMergesFile(
    { version: 2, updatedAt: current.updatedAt, merges },
    { path }
  );
}
