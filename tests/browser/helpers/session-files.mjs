/**
 * Session files (format 4, `assets/js/app/session/history-file.js`) as the
 * browser specs read and make them in the spec's own process, through the
 * app's own modules: the manifest of a saved file, the value a state domain
 * holds at the step it shows, a file whose shown value of one domain is
 * changed (what another engine's derivation of the same state looks like),
 * and the starting view a Save becomes when it is published
 * (`published-default.js`, as `cellucid-datasets` publishes one).
 */
import { hashValue } from '../../../assets/js/app/history/value-pool.js';
import { readBundle } from '../../../assets/js/app/session/bundle/reader.js';
import { writeBundle } from '../../../assets/js/app/session/bundle/writer.js';
import { gzipCompress, gzipDecompress } from '../../../assets/js/app/session/codecs/gzip.js';
import { trimToPublishedDefault } from '../../../assets/js/app/session/published-default.js';
import {
  readHistoryFile, readHistoryFileManifest, sessionHeaderOf, valuesAtStep, writeHistoryFile,
} from '../../../assets/js/app/session/history-file.js';

/** The manifest of a session file. */
export function sessionManifest(bytes) {
  return readHistoryFileManifest(new Blob([bytes]));
}

/** Every tracker, step, journal entry, conversation and value of a session file. */
function readWhole(bytes) {
  return readHistoryFile(new Blob([bytes]));
}

function shownHashes(history) {
  const tracker = history.trackers.find(candidate => candidate.id === history.activeTracker);
  return valuesAtStep(tracker.steps, tracker.headId);
}

/**
 * The value one state domain holds at the step a session file shows (its
 * active tracker's head).
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {string} domainId
 */
export async function shownDomainValue(bytes, domainId) {
  const { history, values } = await readWhole(bytes);
  return values.get(shownHashes(history)[domainId]);
}

/**
 * The same session file with the value one domain shows changed by
 * `edit(value)` (edited in place on a copy), wherever a step holds it.
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {string} domainId
 * @param {(value: any) => void} edit
 * @returns {Promise<Buffer>}
 */
export async function rewriteShownValue(bytes, domainId, edit) {
  const { manifest, history, values } = await readWhole(bytes);
  const before = shownHashes(history)[domainId];
  const value = structuredClone(values.get(before));
  edit(value);
  const after = await hashValue(value);
  values.set(after, value);
  for (const tracker of history.trackers) {
    for (const step of tracker.steps) {
      for (const record of [step.before, step.after]) {
        for (const [id, hash] of Object.entries(record)) if (id === domainId && hash === before) record[id] = after;
      }
    }
  }
  const blob = await writeHistoryFile({
    header: sessionHeaderOf(manifest), app: manifest.app, actions: manifest.actions, scope: manifest.scope, chrome: manifest.chrome, history,
    valueOf: hash => values.get(hash),
  });
  return Buffer.from(await blob.arrayBuffer());
}

/**
 * The starting view a Save becomes when it is published beside its dataset
 * under the identity it was captured on.
 *
 * @param {Uint8Array|Buffer} saveBytes
 * @returns {Promise<Buffer>}
 */
export async function startingViewBytes(saveBytes) {
  const manifest = await sessionManifest(saveBytes);
  const view = await trimToPublishedDefault(new Blob([saveBytes]), manifest.datasetFingerprint);
  return Buffer.from(await view.arrayBuffer());
}

/**
 * Every camera state a value holds (an object with an orbit and a free-fly
 * half), wherever it sits in it.
 *
 * @param {unknown} value
 * @returns {object[]}
 */
export function cameraStatesIn(value) {
  const out = [];
  const visit = node => {
    if (node === null || typeof node !== 'object' || ArrayBuffer.isView(node)) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.orbit !== undefined && node.freefly !== undefined && typeof node.navigationMode === 'string') out.push(node);
    Object.values(node).forEach(visit);
  };
  visit(value);
  return out;
}

/**
 * The same session file as a newer Cellucid would write it with a part of
 * the state this version does not have (`domain`): stamped `version`, the
 * shown tracker's last step also changing that part (to a value the file
 * holds already). What the app reads part by part.
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{domain?: string, version?: string}} [options]
 * @returns {Promise<Buffer>}
 */
export async function withStatePartThisVersionLacks(bytes, { domain = 'holograms', version = '99.0.0' } = {}) {
  const { manifest, chunkStream } = await readBundle(new Blob([bytes]), { signal: null, onProgress: null });
  const chunks = [];
  for await (const chunk of chunkStream) chunks.push(chunk.bytes);
  const changed = structuredClone(manifest);
  changed.app.version = version;
  const tracker = changed.trackers.find(candidate => candidate.id === changed.activeTracker);
  const id = tracker.steps.at(-1);
  const index = changed.chunks.findIndex(chunk => chunk.id === id);
  const meta = changed.chunks[index];
  const raw = meta.codec === 'gzip' ? await gzipDecompress(chunks[index], { maxOutputBytes: meta.uncompressedBytes, signal: null }) : chunks[index];
  const steps = JSON.parse(new TextDecoder().decode(raw));
  const step = steps.findLast(candidate => candidate.parent !== null);
  const held = step.after[step.touches[0]];
  step.touches = [...step.touches, domain];
  step.before[domain] = held;
  step.after[domain] = held;
  const payload = new TextEncoder().encode(JSON.stringify(steps));
  const stored = await gzipCompress(payload, { signal: null });
  changed.chunks[index] = { ...meta, codec: 'gzip', storedBytes: stored.byteLength, uncompressedBytes: payload.byteLength };
  chunks[index] = stored;
  return Buffer.from(await writeBundle({ manifest: changed, chunks }).arrayBuffer());
}
