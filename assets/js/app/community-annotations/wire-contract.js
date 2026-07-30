/**
 * Exact current wire contract for community annotation repositories.
 *
 * These validators accept JSON values without rewriting them. Callers must
 * validate before publishing, caching, or mutating session state.
 */

import { isExactOrcidId } from './profile-identifiers.js';

export const ANNOTATION_CONTRACT_IDS = Object.freeze({
  user: 'https://cellucid.com/contracts/community-annotation/user-v1.schema.json',
  config: 'https://cellucid.com/contracts/community-annotation/config-v1.schema.json',
  merges: 'https://cellucid.com/contracts/community-annotation/merges-v1.schema.json',
});

// GitHub's repository Contents API supports its complete JSON/base64 contract
// only for files whose decoded content is at most 1 MB. Keep this as one shared
// browser/Worker boundary so publication and remote reconciliation cannot drift.
export const ANNOTATION_FILE_MAX_UTF8_BYTES = 1_000_000;

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
  datasets: 200,
  fields: 200,
  bucket: 1024,
  suggestionBuckets: 5000,
  suggestionsPerBucket: 200,
  suggestionId: 128,
  label: 120,
  ontologyId: 64,
  evidence: 2000,
  markers: 50,
  markerGene: 64,
  votes: 50000,
  commentTargets: 10000,
  commentsPerSuggestion: 800,
  commentId: 128,
  commentText: 500,
  deletedBuckets: 10000,
  deletedPerBucket: 5000,
  merges: 5000,
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

export class AnnotationContractError extends Error {
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
  const field = assertNonblankString(
    value,
    path,
    ANNOTATION_LIMITS.datasetId
  );
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

function assertObjectSize(value, path, max) {
  const object = assertRecord(value, path);
  const size = Object.keys(object).length;
  if (size > max) reject(path, `must contain at most ${max} field(s)`);
  return object;
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
  const bucket = assertNonblankString(value, path, ANNOTATION_LIMITS.bucket);
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
    const markers = assertArray(suggestion.markers, child(path, 'markers'), {
      max: ANNOTATION_LIMITS.markers,
    });
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
  const datasets = assertObjectSize(value, path, ANNOTATION_LIMITS.datasets);
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
      child(entryPath, 'fieldsToAnnotate'),
      { max: ANNOTATION_LIMITS.fields }
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
  const suggestions = assertObjectSize(
    document.suggestions,
    child(path, 'suggestions'),
    ANNOTATION_LIMITS.suggestionBuckets
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

  const votes = assertObjectSize(
    document.votes,
    child(path, 'votes'),
    ANNOTATION_LIMITS.votes
  );
  for (const [suggestionId, direction] of Object.entries(votes)) {
    assertSuggestionId(suggestionId, `${child(path, 'votes')} key`);
    if (direction !== 'up' && direction !== 'down') {
      reject(child(child(path, 'votes'), suggestionId), 'must equal "up" or "down"');
    }
  }

  if (Object.hasOwn(document, 'comments')) {
    const comments = assertObjectSize(
      document.comments,
      child(path, 'comments'),
      ANNOTATION_LIMITS.commentTargets
    );
    for (const [suggestionId, listValue] of Object.entries(comments)) {
      assertSuggestionId(suggestionId, `${child(path, 'comments')} key`);
      const listPath = child(child(path, 'comments'), suggestionId);
      const list = assertArray(listValue, listPath, {
        max: ANNOTATION_LIMITS.commentsPerSuggestion,
      });
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
    const deleted = assertObjectSize(
      document.deletedSuggestions,
      child(path, 'deletedSuggestions'),
      ANNOTATION_LIMITS.deletedBuckets
    );
    for (const [bucket, idsValue] of Object.entries(deleted)) {
      assertBucket(bucket, `${child(path, 'deletedSuggestions')} key`);
      const idsPath = child(child(path, 'deletedSuggestions'), bucket);
      const ids = assertArray(idsValue, idsPath, {
        max: ANNOTATION_LIMITS.deletedPerBucket,
      });
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
    { min: 1, max: ANNOTATION_LIMITS.datasets }
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
    const fields = assertArray(entry.fieldsToAnnotate, fieldsPath, {
      min: 1,
      max: ANNOTATION_LIMITS.fields,
    });
    fields.forEach((field, fieldIndex) => {
      assertFieldKey(field, `${fieldsPath}[${fieldIndex}]`);
    });
    assertUniqueStrings(fields, fieldsPath);
    const fieldSet = new Set(fields);

    const settingsPath = child(entryPath, 'annotatableSettings');
    const settings = assertObjectSize(
      entry.annotatableSettings,
      settingsPath,
      ANNOTATION_LIMITS.fields
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
        max: 50,
      });
      assertNumber(setting.threshold, child(settingPath, 'threshold'), {
        min: -1,
        max: 1,
      });
    }

    const closedPath = child(entryPath, 'closedFields');
    const closed = assertArray(entry.closedFields, closedPath, {
      max: ANNOTATION_LIMITS.fields,
    });
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
  const merges = assertArray(document.merges, child(path, 'merges'), {
    max: ANNOTATION_LIMITS.merges,
  });
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
