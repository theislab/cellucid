/**
 * One transcoding, from a source to the store of what it holds, kept across
 * visits (`space.js` says for how long): the store of the same source
 * opened before (in this tab, another one, or an earlier visit) is reused;
 * otherwise a space is opened, the format's `build` writes one store per
 * object the source holds, the manifest is written last, and the person
 * picks among several objects (D20).
 *
 * @module data/anndata/transcode/session
 */

import { THIS_TAB, findKeptStore, makeRoomForRetry, openTranscodeSpace } from './space.js';
import { entriesFromJson, entriesToJson, keptStore } from './kept-store.js';
import { RObjectRefusal } from './refusals.js';

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
 * @param {number|null} [options.bytes] - The bytes a pass reads (the file's
 *   size; a folder's: the files it reads), told to `onWholeRead`
 * @param {() => Promise<boolean>} [options.readsWhole] - Whether a pass reads
 *   the source whole (an uncompressed R file is read by its structure, its
 *   arrays in place); asked only when a pass is made
 * @param {Object|null} options.link - The link the source is read over
 * @param {Map<string, {read: Function}>} [options.sourceBlobs] - Blobs that
 *   are the source's own files (`file`: an uncompressed R file read in place)
 * @param {Object} options.context - The transcoder context (`choose`,
 *   `onStore`, `expect`; `format`: the input format id;
 *   `onWholeRead({format, bytes, kept, persistent, reused})`: told before
 *   the pass reads anything, or when a kept store is opened instead, so the
 *   person hears it up front (`data/whole-read-notice.js`);
 *   `memory`: keep the store in memory; `tab`: the page's tab
 *   (`space.js` `THIS_TAB`, handed to the reader worker), which alone opens
 *   again a store kept for one tab only;
 *   `environment`: whose `navigator.storage` and `navigator.locks`, the
 *   worker's own by default)
 * @param {(space: Object) => Promise<BuiltObject[]>} options.build
 * @returns {Promise<{store: Object, name: string, link: Object|null, conversion: Readonly<Conversion>, object: Object}>}
 */
export async function transcodeOnce(options) {
  try {
    return await transcodeOnceIn(options);
  } catch (error) {
    // Refused for the site's quota part way: the kept stores nobody holds
    // make room, and the pass runs once more (reading the source again).
    if (error?.details?.reason !== 'storage-full' || options.context.memory === true) throw error;
    const deficit = Number.isFinite(error.details.written) ? error.details.written : Infinity;
    if (await makeRoomForRetry(options.context.environment ?? globalThis, deficit) === 0) throw error;
    return transcodeOnceIn(options);
  }
}

async function transcodeOnceIn({ identity, fileName, bytes = null, readsWhole = async () => true, link, sourceBlobs = new Map(), context, build }) {
  const { choose = null, onStore = null, onWholeRead = null, expect = null, memory = false, environment = globalThis, tab = THIS_TAB } = context;
  const format = context.format ?? expect?.format ?? null;
  const kept = memory ? null : await findKeptStore(identity, environment, { tab });
  if (kept !== null) {
    onStore?.({ directory: kept.directory, state: 'complete' });
    if (kept.manifest.whole !== false) onWholeRead?.({ format, bytes, kept: 'opfs', persistent: kept.manifest.persist === true, reused: true });
    for (const [name, blob] of sourceBlobs) kept.blobs.set(name, blob);
    const chosen = await pickObject(kept.manifest.objects, fileName, { expect, choose });
    return {
      store: keptStore(entriesFromJson(chosen.entries), kept.blobs, fileName),
      name: fileName,
      link,
      conversion: conversionOf('opfs', true, kept.manifest.persist === true, kept.manifest.whole !== false, chosen.notes ?? []),
      object: { name: chosen.name, kind: chosen.kind, version: chosen.version },
    };
  }
  const space = await openTranscodeSpace(identity, {
    memory,
    environment,
    tab,
    onDirectory: directory => onStore?.({ directory, state: 'writing' }),
  });
  let whole;
  try {
    whole = await readsWhole();
  } catch (error) {
    await space.discard();
    throw error;
  }
  if (whole) onWholeRead?.({ format, bytes, kept: space.kind, persistent: space.persistent, reused: false });
  let objects;
  let blobs;
  try {
    objects = await build(space);
    const used = new Set();
    for (const object of objects) for (const blob of object.written.used) if (!sourceBlobs.has(blob)) used.add(blob);
    const manifest = {
      whole,
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
  // Complete: kept (for later visits, or the tab's life), whichever object
  // is opened (or none, yet).
  if (space.directory !== null) onStore?.({ directory: space.directory, state: 'complete' });
  const chosen = await pickObject(objects, fileName, { expect, choose });
  return {
    store: keptStore(chosen.written.entries, blobs, fileName),
    name: fileName,
    link,
    conversion: conversionOf(space.kind, false, space.persistent, whole, chosen.notes),
    object: { name: chosen.name, kind: chosen.kind, version: chosen.version },
  };
}

/**
 * @typedef {Object} Conversion - What reading a single-stream format once
 *   made of it, as the Dataset box says it
 * @property {'opfs'|'memory'} kept - Where the store is kept: this
 *   browser's storage (the origin-private file system), or memory where
 *   there is none (a Firefox private window), for the tab's life
 * @property {boolean} persistent - Kept in this browser's storage for later
 *   visits (the source's identity names its version), not only this tab
 * @property {boolean} whole - The source was read whole (false: an
 *   uncompressed R file, whose structure was read and whose arrays are read
 *   in place)
 * @property {boolean} reused - Opened from what an earlier opening of the
 *   same source kept (in this tab, another one, or an earlier visit),
 *   without reading it again
 * @property {readonly string[]} notes - What was not read, and why
 */

/** @returns {Readonly<Conversion>} */
function conversionOf(kept, reused, persistent, whole, notes) {
  return Object.freeze({ kept, persistent, whole, reused, notes: Object.freeze([...notes]) });
}

