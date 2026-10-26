/**
 * One transcoding, from a source to the store of what it holds, kept for
 * the tab's life: the store of the same source opened before in this tab is
 * reused; otherwise a space is opened (`space.js`), the format's `build`
 * writes one store per object the source holds, the manifest is written
 * last, and the person picks among several objects (D20).
 *
 * @module data/anndata/transcode/session
 */

import { findKeptStore, openTranscodeSpace } from './space.js';
import { entriesFromJson, entriesToJson, keptStore } from './kept-store.js';
import { RObjectRefusal } from './refusals.js';

/** Version of the kept manifest; a manifest of another version is passed over. */
const MANIFEST_VERSION = 1;

/**
 * Pick one of several kept objects: the only one, the one `expect.object`
 * names, or the person's choice.
 */
async function pickObject(objects, fileName, { expect = null, choose = null } = {}) {
  if (objects.length === 1) return objects[0];
  const named = expect?.object === undefined ? null : objects.find(object => object.name === expect.object);
  if (named) return named;
  const labels = objects.map(object => object.label);
  if (typeof choose !== 'function') {
    throw new RObjectRefusal(
      `${fileName} holds ${objects.length} single-cell objects: ${labels.join(' · ')}. ` +
      'Open it in Cellucid and choose one, or save the one to open on its own (in R, saveRDS(object, file)).',
      { reason: 'several-objects' }
    );
  }
  const index = await choose({ question: `${fileName} holds ${objects.length} single-cell objects. Open which one?`, options: labels });
  const chosen = objects[index];
  if (chosen === undefined) throw new RObjectRefusal('No object was chosen.', { reason: 'not-chosen' });
  return chosen;
}

/**
 * @typedef {Object} BuiltObject
 * @property {string} name - Its name in the source (`''` for the only one)
 * @property {string} label - How the person is offered it
 * @property {string} kind
 * @property {string|null} version
 * @property {string[]} notes - What was not read, and why
 * @property {{entries: Map<string, Object>, used: Set<string>}} written
 */

/**
 * @param {Object} options
 * @param {Object|null} options.identity - The source's identity (reuse key)
 * @param {string} options.fileName - How messages name the source
 * @param {Object|null} options.link - The link the source is read over
 * @param {Map<string, {read: Function}>} [options.sourceBlobs] - Blobs that
 *   are the source's own files (`file`: an uncompressed R file read in place)
 * @param {Object} options.context - The transcoder context (`choose`,
 *   `onStore`, `expect`; `memory`: keep the store in memory;
 *   `environment`: whose `navigator.storage` and `navigator.locks`, the
 *   worker's own by default)
 * @param {(space: Object) => Promise<BuiltObject[]>} options.build
 * @returns {Promise<{store: Object, name: string, link: Object|null, conversion: Readonly<Conversion>, object: Object}>}
 */
export async function transcodeOnce({ identity, fileName, link, sourceBlobs = new Map(), context, build }) {
  const { choose = null, onStore = null, expect = null, memory = false, environment = globalThis } = context;
  const kept = memory ? null : await findKeptStore(identity, environment);
  if (kept !== null) {
    if (kept.manifest.version === MANIFEST_VERSION) {
      onStore?.({ directory: kept.directory, state: 'complete' });
      for (const [name, blob] of sourceBlobs) kept.blobs.set(name, blob);
      const chosen = await pickObject(kept.manifest.objects, fileName, { expect, choose });
      return {
        store: keptStore(entriesFromJson(chosen.entries), kept.blobs, fileName),
        name: fileName,
        link,
        conversion: conversionOf('opfs', true, chosen.notes ?? []),
        object: { name: chosen.name, kind: chosen.kind, version: chosen.version },
      };
    }
    kept.release();
  }
  const space = await openTranscodeSpace(identity, {
    memory,
    environment,
    onDirectory: directory => onStore?.({ directory, state: 'writing' }),
  });
  let objects;
  let blobs;
  try {
    objects = await build(space);
    const used = new Set();
    for (const object of objects) for (const blob of object.written.used) if (!sourceBlobs.has(blob)) used.add(blob);
    const manifest = {
      version: MANIFEST_VERSION,
      objects: objects.map(object => ({
        name: object.name,
        label: object.label,
        kind: object.kind,
        version: object.version,
        notes: object.notes,
        entries: entriesToJson(object.written.entries),
      })),
    };
    blobs = await space.finish(manifest, used);
  } catch (error) {
    await space.discard();
    throw error;
  }
  for (const [name, blob] of sourceBlobs) blobs.set(name, blob);
  // Complete: kept for the tab's life, whichever object is opened (or none, yet).
  if (space.directory !== null) onStore?.({ directory: space.directory, state: 'complete' });
  const chosen = await pickObject(objects, fileName, { expect, choose });
  return {
    store: keptStore(chosen.written.entries, blobs, fileName),
    name: fileName,
    link,
    conversion: conversionOf(space.kind, false, chosen.notes),
    object: { name: chosen.name, kind: chosen.kind, version: chosen.version },
  };
}

/**
 * @typedef {Object} Conversion - What reading a single-stream format once
 *   made of it, as the Dataset box says it
 * @property {'opfs'|'memory'} kept - Where the store is kept for the tab's
 *   life: this browser's storage (the origin-private file system), or memory
 *   where there is none (a Firefox private window)
 * @property {boolean} reused - Opened from what an earlier opening of the
 *   same source kept in this tab, without reading it again
 * @property {readonly string[]} notes - What was not read, and why
 */

/** @returns {Readonly<Conversion>} */
function conversionOf(kept, reused, notes) {
  return Object.freeze({ kept, reused, notes: Object.freeze([...notes]) });
}

