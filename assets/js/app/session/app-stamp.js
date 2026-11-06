/**
 * @fileoverview What wrote a session file: the Cellucid version and the
 * action catalogue it was written with (`app`), and the parameter schema of
 * each action its steps use (`actions`), so a reader knows which steps it can
 * replay (History v2 §3.8).
 *
 * - `app.catalog` is the SHA-256 of the catalogue document's canonical text
 *   ({@link canonicalCatalogText}), the same text
 *   `scripts/generate-action-catalog.mjs` writes and the three repositories
 *   pin.
 * - `actions` is one `{type, version, params}` per action type and version
 *   the recorded steps use that this catalogue knows, sorted; `params` is the
 *   SHA-256 of that version's parameters shape (`actionParamsShape`) as
 *   canonical JSON (keys sorted, no white space) when this catalogue is at
 *   that version, null for an earlier one. A step whose type and version are
 *   not listed was recorded with another version.
 *
 * Pure; importable in Node.
 *
 * @module session/app-stamp
 */

import { actionParamsShape, catalogDocument } from '../actions/catalog.js';
import { sha256Hex } from '../utils/sha256.js';
import { OUTSIDE_CHANGE_TYPE } from '../history/model.js';

/** `value` with every object's keys sorted, recursively (lists keep their order). */
export function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]));
  }
  return value;
}

/** The catalogue document's canonical text: keys sorted, two-space indent, a final newline. */
export function canonicalCatalogText(catalog) {
  return `${JSON.stringify(sortedKeys(catalogDocument(catalog)), null, 2)}\n`;
}

const encoder = new TextEncoder();
const catalogDigests = new WeakMap();
const paramDigests = new WeakMap();

function textDigest(text) {
  return sha256Hex(encoder.encode(text));
}

/** The SHA-256 of a catalogue's canonical text (once per catalogue). */
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

/** The SHA-256 of one action's parameters shape (`actionParamsShape` of its schema) as canonical JSON. */
export function paramsDigest(definition) {
  if (!paramDigests.has(definition)) paramDigests.set(definition, textDigest(JSON.stringify(sortedKeys(actionParamsShape(definition.params)))));
  return paramDigests.get(definition);
}

/**
 * The `actions` stamp: one per action type and version the recorded steps
 * use (`kind: 'action'`), sorted by type then version, with the digest of
 * that version's parameters shape when this catalogue is at that version,
 * null for an earlier one (its upgraders take it forward). A type this
 * catalogue lacks is not stamped: a reader shows its steps as recorded with
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
 * The action types of a file this catalogue cannot replay as recorded, each
 * with the sentence the history shows for its steps: a type this catalogue
 * lacks or the writer did not stamp at the step's version; a version newer
 * than this catalogue's; the version this catalogue is at, with another
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
