/**
 * The transcoder of R files: `.rds` (one object) and `.rda`/`.RData` (the
 * named objects `save()` writes). One pass over the file (`formats/rds`)
 * keeps what a Seurat object or a SingleCellExperiment shows, and the store
 * is written from the parsed object (`seurat.js`, `sce.js`,
 * `anndata-model.js`) into the transcode space (`space.js`), kept for the
 * tab's life (`session.js`).
 *
 * - An uncompressed file is not copied: its structure is read by ranges,
 *   and the store's large arrays are regions of the file itself (read in
 *   place, from this computer or a web host).
 * - A `save()` file with several single-cell objects keeps every one of
 *   them in the same pass; the person then picks one (`context.choose`),
 *   and a later choice in the same tab opens from what was kept.
 * - A Seurat v2 object, an object with no cell embedding, or one whose
 *   matrices live outside the file are refused with what to do.
 *
 * @module data/anndata/transcode/r-object
 */

import { INLINE_ELEMENTS, isUncompressed, readRFile, savedObjects } from '../../../formats/rds/index.js';
import { hasClass, classesOf, namedItems } from './r-values.js';
import { isDroppedSeuratLayer, SEURAT_DROPPED_SLOTS, isSeurat, isSeuratV2, seuratModel } from './seurat.js';
import { isSingleCellExperiment, isSummarizedExperiment, sceModel } from './sce.js';
import { writeModel } from './anndata-model.js';
import { RObjectRefusal, noEmbeddingRefusal } from './refusals.js';
import { transcodeOnce } from './session.js';
import { formatBytes, formatCountOf } from '../../../utils/format-units.js';

/** Slots whose large vectors are never needed (the small ones are: `misc$cellucid`). */
const SMALL_ONLY = new Set(['@misc', '@tools', '@metadata', '@int_metadata']);
const DROPPED = new Set(SEURAT_DROPPED_SLOTS);

/**
 * The numeric payloads of a sparse matrix (`dgCMatrix`, a Seurat `Graph`).
 * Their `names` attribute is never read: arithmetic on `@x` in R (`rep()`
 * of a named `colSums()`) leaves one name per stored value on it, and
 * decoding those strings cost a 100,000-cell SingleCellExperiment 7 of its
 * 10.7 s pass.
 */
const SPARSE_PAYLOADS = new Set(['@x', '@i', '@p']);

/** What the pass keeps (`formats/rds/parse.js` plan). */
export const R_OBJECT_PLAN = Object.freeze({
  drop: path => DROPPED.has(path[path.length - 1])
    || (path[path.length - 1] === '@names' && SPARSE_PAYLOADS.has(path[path.length - 2])),
  // A Seurat v5 assay's layers are a named list, whose names follow its
  // elements: `scale.data` is given back as soon as they arrive.
  dropByName: path => (path[path.length - 1] === '@layers' ? isDroppedSeuratLayer : null),
  vector: (path, { length }) => (length > INLINE_ELEMENTS && path.some(segment => SMALL_ONLY.has(segment)) ? 'skip' : 'keep'),
});

/**
 * The parts of an object the pass dropped that held something
 * (`R_OBJECT_PLAN`: `scale.data`, `commands`, feature loadings, …),
 * one note each, named by their R path and the bytes they took in the file.
 * An empty slot (an empty matrix or list) is not mentioned.
 *
 * @param {Object} node - A parsed single-cell object
 * @returns {string[]}
 */
export function passedOverNotes(node) {
  const notes = [];
  const seen = new Set();
  const walk = (value, where) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.kind === 'skipped') {
      if (value.bytes !== undefined && !value.empty) {
        notes.push(`${where} (${formatBytes(value.bytes)}): Cellucid does not use it.`);
      }
      return;
    }
    for (const [name, slot] of Object.entries(value.attributes ?? {})) {
      if (name !== 'names' && name !== 'class' && name !== 'dim' && name !== 'dimnames') walk(slot, `${where}@${name}`);
    }
    if (value.kind === 'list') {
      for (const [index, entry] of namedItems(value).entries()) walk(entry.value, `${where}$${entry.name ?? `[[${index + 1}]]`}`);
    }
  };
  walk(node, '');
  // A slot of the object itself is named without its leading `@`.
  return notes.map(note => (note.startsWith('@') ? note.slice(1) : note));
}

/** What one top-level object is. */
function kindOf(node) {
  if (isSeurat(node)) return 'Seurat';
  if (isSeuratV2(node)) return 'Seurat v2';
  if (isSingleCellExperiment(node)) return 'SingleCellExperiment';
  if (isSummarizedExperiment(node)) return classesOf(node)[0] ?? 'SummarizedExperiment';
  return null;
}

function describeOther(node) {
  if (node?.kind === 'list' && hasClass(node, 'data.frame')) return 'an R data frame';
  if (node?.kind === 'S4') return `an R ${classesOf(node)[0] ?? 'S4'} object`;
  if (node?.kind === 'list') return 'an R list';
  return `an R ${node?.kind ?? 'value'}`;
}

/** The model of one single-cell object, refused when Cellucid cannot show it. */
async function modelOf(node, kind, context) {
  if (kind === 'Seurat v2') {
    throw new RObjectRefusal(
      'This is a Seurat v2 object (2017–2018), which Cellucid does not read. In R: seu <- SeuratObject::UpdateSeuratObject(seu), then saveRDS(seu, file).',
      { reason: 'old-version' }
    );
  }
  const model = kind === 'Seurat' ? await seuratModel(node, context) : await sceModel(node, context);
  if (model.obsm.length === 0) throw noEmbeddingRefusal(`This ${model.kind === 'Seurat' ? 'Seurat object' : model.kind}`);
  return model;
}

/** The source file as a blob of the store (an uncompressed file's regions). */
function fileBlob(reader) {
  return { read: (offset, length, options = {}) => reader.read(offset, length, options).then(bytes => bytes.slice()) };
}

/**
 * Transcode one R file into the store of the object it holds.
 *
 * @param {Object} source - `{file}`
 * @param {Object} context - `openDatasetStore`'s transcoder context:
 *   `{signal, activity, byteReaderOf, createActivity?, choose?, onStore?, expect?, memory?}`
 * @returns {Promise<{store: Object, name: string, link: Object, conversion: Object, object: Object}>}
 */
export async function transcodeRFile(source, context) {
  const { signal = null, byteReaderOf } = context;
  const file = source.file;
  if (file === undefined) throw new RObjectRefusal('An R object is one file (.rds, .rda or .RData), not a folder.');
  const reader = byteReaderOf(file);
  const fileName = file.name ?? reader.name ?? 'This file';
  // The pass is an activity of its own when the caller can make one (what
  // the opening shows as its step); else it counts into the opening's.
  const own = context.createActivity?.({ kind: 'transcode', label: fileName }) ?? null;
  const activity = own ?? context.activity ?? null;
  activity?.expect?.(reader.size);
  try {
    const result = await transcodeOnce({
      identity: reader.identity,
      fileName,
      bytes: reader.size,
      // An uncompressed file is read by its structure, its arrays in place.
      readsWhole: async () => !isUncompressed(await reader.read(0, Math.min(16, reader.size), { signal })),
      link: reader.link,
      sourceBlobs: new Map([['file', fileBlob(reader)]]),
      context,
      build: space => buildObjects(reader, fileName, space, { signal, activity }),
    });
    own?.finish();
    return result;
  } catch (error) {
    own?.finish(error);
    throw error;
  }
}

async function buildObjects(reader, fileName, space, { signal, activity }) {
  const parsed = await readRFile(reader, { plan: R_OBJECT_PLAN, sink: space.sink, signal, activity });
  const readRegion = region => (region.store === 'file'
    ? reader.read(region.offset, region.byteLength, { signal }).then(bytes => bytes.slice())
    : space.read(region));
  // An uncompressed file's arrays are read in place, never copied: its store
  // keeps the object's order of cells (`priority.js`).
  const ordered = !isUncompressed(await reader.read(0, Math.min(16, reader.size), { signal }));
  const modelContext = { space, readRegion, signal, ordered };
  const candidates = parsed.container === 'rda' ? savedObjects(parsed.root) : [{ name: null, value: parsed.root }];
  const objects = [];
  const others = [];
  let refusal = null;
  for (const { name, value } of candidates) {
    const kind = kindOf(value);
    if (kind === null) {
      others.push(name === null ? describeOther(value) : `${name} (${describeOther(value)})`);
      continue;
    }
    let model;
    try {
      model = await modelOf(value, kind, modelContext);
    } catch (error) {
      if (!(error instanceof RObjectRefusal) || candidates.length === 1) throw error;
      refusal ??= error;
      others.push(`${name} (${kind}: ${error.message})`);
      continue;
    }
    model.notes.push(...passedOverNotes(value));
    const written = await writeModel(model, space, modelContext);
    const label = `${name ?? fileName} (${model.kind}, ${formatCountOf(written.nObs, 'cell')})`;
    objects.push({ name: name ?? '', label, kind: model.kind, version: model.version, notes: model.notes, written });
  }
  if (objects.length === 0) {
    if (refusal !== null && others.length === 1) throw refusal;
    throw new RObjectRefusal(
      `${fileName} holds ${others.join(', ')}, not a Seurat object or a SingleCellExperiment it can show. ` +
      'Cellucid opens Seurat (v3 and later), SingleCellExperiment and SummarizedExperiment objects saved with saveRDS() or save().',
      { reason: refusal?.reason ?? 'not-single-cell' }
    );
  }
  return objects;
}
