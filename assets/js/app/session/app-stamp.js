/**
 * @fileoverview What wrote a session file: the Cellucid version and the
 * action catalog it was written with (`app`), and the parameter schema of
 * each action its steps use (`actions`), so a reader knows which steps it can
 * replay.
 *
 * - `app.catalog` is the SHA-256 of the catalog document's canonical text
 *   ({@link canonicalCatalogText}), the same text
 *   `scripts/generate-action-catalog.mjs` writes and the three repositories
 *   pin.
 * - `actions` is one `{type, version, params}` per action type and version
 *   the recorded steps use that this catalog knows, sorted; `params` is the
 *   SHA-256 of that version's parameters shape (`actionParamsShape`) as
 *   canonical JSON (keys sorted, no white space) when this catalog is at
 *   that version, null for an earlier one. A step whose type and version are
 *   not listed was recorded with another version.
 *
 * Pure; importable in Node.
 *
 * @module session/app-stamp
 */

import { actionParamsShape, catalogDocument } from '../actions/catalog.js';
import { sha256Hex } from '../../utils/sha256.js';
import { OUTSIDE_CHANGE_TYPE } from '../history/model.js';

/** `value` with every object's keys sorted, recursively (lists keep their order). */
export function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]));
  }
  return value;
}

/** The catalog document's canonical text: keys sorted, two-space indent, a final newline. */
function canonicalCatalogText(catalog) {
  return `${JSON.stringify(sortedKeys(catalogDocument(catalog)), null, 2)}\n`;
}

const encoder = new TextEncoder();
const catalogDigests = new WeakMap();
const paramDigests = new WeakMap();

function textDigest(text) {
  return sha256Hex(encoder.encode(text));
}

/** The SHA-256 of a catalog's canonical text (once per catalog). */
export function catalogDigest(catalog) {
  if (!catalogDigests.has(catalog)) catalogDigests.set(catalog, textDigest(canonicalCatalogText(catalog)));
  return catalogDigests.get(catalog);
}

/**
 * The `app` stamp of a file written now.
 * @param {{catalog: object, version: string}} options - `version`: `<meta name="cellucid-version">`
 * @returns {Promise<{version: string, catalog: string}>}
 */
export async function appStamp({ catalog, version }) {
  if (typeof version !== 'string' || version.length === 0) throw new TypeError('A session file names the Cellucid version that wrote it.');
  return { version, catalog: await catalogDigest(catalog) };
}

/** `a` against `b` as release versions (`0.9.8`, `0.10.0rc1`): numbers compared as numbers, -1, 0 or 1. */
function compareVersions(a, b) {
  const parts = text => String(text).match(/\d+|[A-Za-z]+/g) ?? [];
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? '', y[i] ?? ''];
    if (p === q) continue;
    const [m, n] = [Number(p), Number(q)];
    if (p !== '' && q !== '' && Number.isFinite(m) && Number.isFinite(n)) return m < n ? -1 : 1;
    // A pre-release tag (`rc1`) comes before the release it leads to; then text order.
    if (p === '') return /^\d/.test(q) ? -1 : 1;
    if (q === '') return /^\d/.test(p) ? 1 : -1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a saved history (a session file, a saved state of this browser)
 * was written by another version of Cellucid than this page, from its `app`
 * stamp: `'earlier'` when it names an earlier version, or this
 * version with another action catalog (a build of it before this one),
 * `'newer'` when it names a later version, null when it was written by
 * this version and catalog, or names none. A part such a history holds
 * that this version cannot read is said as that, never as a problem inside
 * Cellucid (`session-serializer.js` `describeUnrestored`).
 *
 * @param {{version?: unknown, catalog?: unknown}|null|undefined} app - the history's `app` stamp
 * @param {{catalog: object, version: string|null}} page - this page's catalog and version
 * @returns {Promise<'earlier'|'newer'|null>}
 */
export async function writtenByOtherVersion(app, { catalog, version }) {
  if (app === null || typeof app !== 'object' || typeof app.version !== 'string') return null;
  const order = typeof version === 'string' ? compareVersions(app.version, version) : 0;
  if (order > 0) return 'newer';
  if (order < 0) return 'earlier';
  return app.catalog === await catalogDigest(catalog) ? null : 'earlier';
}

/** The SHA-256 of one action's parameters shape (`actionParamsShape` of its schema) as canonical JSON. */
function paramsDigest(definition) {
  if (!paramDigests.has(definition)) paramDigests.set(definition, textDigest(JSON.stringify(sortedKeys(actionParamsShape(definition.params)))));
  return paramDigests.get(definition);
}

/**
 * The `actions` stamp: one per action type and version the recorded steps
 * use (`kind: 'action'`), sorted by type then version, with the digest of
 * that version's parameters shape when this catalog is at that version,
 * null for an earlier one (its upgraders take it forward). A type this
 * catalog lacks is not stamped: a reader shows its steps as recorded with
 * another version.
 *
 * @param {Iterable<{kind: string, type: string|null, v: number|null}>} steps
 * @param {{has: (type: string) => boolean, get: (type: string) => object}} catalog
 * @returns {Promise<Array<{type: string, version: number, params: string|null}>>}
 */
export async function actionStamps(steps, catalog) {
  const used = new Map();
  for (const step of steps) {
    if (step.kind !== 'action' || !catalog.has(step.type)) continue;
    used.set(`${step.type}\u0000${step.v}`, [step.type, step.v]);
  }
  const sorted = [...used.values()].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x - y));
  return Promise.all(sorted.map(async ([type, version]) => {
    const definition = catalog.get(type);
    return { type, version, params: version === definition.version ? await paramsDigest(definition) : null };
  }));
}

/**
 * The action types of a file this catalog cannot replay as recorded, each
 * with the sentence the history shows for its steps: a type this catalog
 * lacks or the writer did not stamp at the step's version; a version newer
 * than this catalog's; the version this catalog is at, with another
 * parameters shape. An older version is upgraded by a replay
 * (`upgradeParams`). Changes made outside an action are skipped by a replay
 * and never listed.
 *
 * @param {{app: {version: string}, actions: Array<{type: string, version: number, params: string|null}>}} manifest
 * @param {Iterable<{kind?: string, type: string|null, v: number|null}>} steps
 * @param {{has: Function, get: Function}} catalog
 * @returns {Promise<Map<string, string>>}
 */
export async function foreignActions(manifest, steps, catalog) {
  const stamped = new Map(manifest.actions.map(stamp => [`${stamp.type}\u0000${stamp.version}`, stamp.params]));
  const other = `Recorded with another version (${manifest.app.version}): shown, not replayable.`;
  const newer = `Recorded with a newer Cellucid (${manifest.app.version}): shown, not replayable.`;
  const out = new Map();
  for (const { type, v } of steps) {
    if (type === null || type === OUTSIDE_CHANGE_TYPE || out.has(type) || v === null) continue;
    const key = `${type}\u0000${v}`;
    const definition = catalog.has(type) ? catalog.get(type) : null;
    if (definition !== null && v > definition.version) out.set(type, newer);
    else if (definition === null || !stamped.has(key)) out.set(type, other);
    else if (v === definition.version && stamped.get(key) !== await paramsDigest(definition)) out.set(type, other);
  }
  return out;
}
