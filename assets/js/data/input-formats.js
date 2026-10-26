/**
 * The input formats Cellucid opens: the one place that knows what a file or
 * folder is from its name or its first bytes.
 *
 * Every entry point asks this module: the Open… menu (its `accept` list),
 * a drop, the address bar's routing, the link providers and the dataset
 * catalog, the served-store validator, the Dataset box's wording, and the
 * reader worker (`anndata/open.js`), which decides from content. Python
 * (`cellucid serve`) and R read the same rules from
 * `tests/fixtures/input-formats.json`, which is this module's document
 * byte for byte (`inputFormatsJson()`), so the three name the same formats
 * the same way.
 *
 * Words:
 *
 * - A **layout** is how a dataset arrives: `file` (one file that is the
 *   container itself, an `.h5ad`), `zip` (one ZIP archive holding a store
 *   folder, a `.zarr.zip`) or `folder` (a folder: a Zarr store, a Cell Ranger
 *   `outs/` folder or a MatrixMarket folder; picked, dropped, or on a web
 *   host).
 * - A **container** is what the reader opens the bytes with: `hdf5`
 *   (`formats/hdf5`), `zarr` (`formats/zarr`, over a folder, a ZIP archive
 *   or a web host), `rds` (`formats/rds`, an R serialization read once from
 *   the start) or `text` (`formats/text`, MatrixMarket and its lists).
 * - A **format** is what the container holds, by its id (`INPUT_FORMATS`:
 *   `h5ad`, `zarr`, `loom`, `tenx-h5`, `tenx-outs`, `h5mu`, `mudata-zarr`,
 *   `rds`, `rda`, `h5seurat`, `mtx`). The id is stable: sessions (a dataset
 *   that states no id is `<format>_<name>`), a server's `anndata.file.kind`,
 *   its health `format`, and the tests name it. A format other than `h5ad`
 *   and `zarr` is presented as AnnData by a layout view
 *   (`anndata/views/index.js`, read in place) or a transcoder
 *   (`anndata/transcode/`, read once into this browser).
 *
 * The name decides whether an entry point takes a file at all (the same rule
 * everywhere, before anything is read). Content decides what it is once its
 * bytes are at hand: a file whose first bytes carry a container's signature
 * is opened as that container whatever its name says.
 *
 * @module data/input-formats
 */

/**
 * @typedef {'file'|'zip'|'folder'} InputLayout
 * @typedef {'hdf5'|'zarr'|'rds'|'text'} InputContainer
 *
 * @typedef {Object} InputFormat
 * @property {string} id - Stable format id
 * @property {string} label - What the Dataset box and messages call it
 * @property {'python'|'r'|'any'} ecosystem - Which language's tools write
 *   it, for the small tag examples carry; `any` when both do
 * @property {'ranges'|'stream'} access - `ranges`: read in place, only the
 *   parts a view needs; `stream`: read once from the start
 * @property {InputContainer} container
 * @property {Readonly<Partial<Record<InputLayout, ReadonlyArray<string>>>>} names -
 *   The lower-case name endings of each layout the format arrives in,
 *   longest first (a folder's are its own name's endings); a message names
 *   a format by its first ending that is not a compressed copy's
 *   (`standsAlone`)
 * @property {string} writeAgain - What to do with a file the browser cannot
 *   read, in the words of the tools that write the format
 * @property {string} [refusal] - Present on a format Cellucid recognises but
 *   never opens: the whole message, with the route that converts it. The web
 *   app, `cellucid serve` (Python) and `cellucid_serve()` (R) refuse such a
 *   file with exactly these words, so the three never disagree on it.
 */

/** The document's version: a reader of `input-formats.json` checks it. */
export const INPUT_FORMATS_SCHEMA = 1;

/**
 * Container signatures: bytes at the start of one file (at any of
 * `offsets`), and the layout and container they make it. HDF5's signature
 * sits after a user block when the file has one (`formats/hdf5/superblock.js`
 * looks at 0, 512, 1024 and 2048 in its first read, then further); a user
 * block longer than these is told by the file's name.
 */
const SIGNATURES = Object.freeze([
  Object.freeze({ offsets: Object.freeze([0, 512, 1024, 2048]), hex: '894844460d0a1a0a', layout: 'file', container: 'hdf5' }),
  Object.freeze({ offsets: Object.freeze([0]), hex: '504b0304', layout: 'zip', container: 'zarr' }),
  // An empty archive is its end record alone.
  Object.freeze({ offsets: Object.freeze([0]), hex: '504b0506', layout: 'zip', container: 'zarr' }),
]);

/**
 * The files that make a folder (or the folder inside a ZIP archive) one
 * format's, by format id: any one of them, at the folder's root or below
 * it. Formats are tried in registry order, so an earlier format's markers
 * win (a Cell Ranger `outs/` folder also holds a MatrixMarket folder).
 */
const FOLDER_MARKERS = Object.freeze({
  zarr: Object.freeze(['.zarray', '.zattrs', '.zgroup', '.zmetadata', 'zarr.json']),
  'tenx-outs': Object.freeze(['filtered_feature_bc_matrix.h5', 'sample_filtered_feature_bc_matrix.h5', 'filtered_gene_bc_matrices_h5.h5']),
  mtx: Object.freeze(['matrix.mtx.gz', 'matrix.mtx', 'cells_x_genes.mtx', 'quants_mat.mtx', 'count_matrix.mtx', 'DGE.mtx']),
});

/**
 * Folder formats whose marker files may carry a sample prefix, and the
 * characters such a prefix ends with: GEO's `GSM123_matrix.mtx.gz` beside
 * `GSM123_barcodes.tsv.gz`. A prefixed marker makes the folder the format's
 * when another file of the same folder starts with the prefix's first part
 * (`GSM123_`): a prefix the files share, not a name that merely ends alike.
 */
const FOLDER_MARKER_PREFIXES = Object.freeze({
  mtx: '_-.',
});

/** @type {ReadonlyArray<Readonly<InputFormat>>} */
export const INPUT_FORMATS = Object.freeze([
  Object.freeze({
    id: 'h5ad',
    label: 'AnnData (.h5ad)',
    ecosystem: 'python',
    access: 'ranges',
    container: 'hdf5',
    names: Object.freeze({ file: Object.freeze(['.h5ad']) }),
    writeAgain: "Save it again with anndata (adata.write_h5ad(new_path), or compression='gzip'), or serve it with cellucid serve, then open the new file.",
  }),
  Object.freeze({
    id: 'zarr',
    label: 'AnnData Zarr',
    ecosystem: 'any',
    access: 'ranges',
    container: 'zarr',
    names: Object.freeze({
      zip: Object.freeze(['.zarr.zip', '.zip']),
      folder: Object.freeze(['.zarr']),
    }),
    writeAgain: 'Write it again with anndata (adata.write_zarr(new_path)), or serve it with cellucid serve, then open the new store.',
  }),
  Object.freeze({
    id: 'loom',
    label: 'Loom (.loom)',
    ecosystem: 'any',
    access: 'ranges',
    container: 'hdf5',
    names: Object.freeze({ file: Object.freeze(['.loom']) }),
    writeAgain: 'Write it again with loompy (loompy.create), or read it with scanpy (sc.read_loom(path)) and save it with adata.write_h5ad(new_path), then open the new file.',
  }),
  Object.freeze({
    id: 'tenx-h5',
    label: '10x Cell Ranger HDF5 (.h5)',
    ecosystem: 'any',
    access: 'ranges',
    container: 'hdf5',
    names: Object.freeze({ file: Object.freeze(['.h5']) }),
    writeAgain: 'Read it with scanpy (sc.read_10x_h5(path)) or Seurat (Read10X_h5(path)) and save it as .h5ad or with cellucid_prepare(), then open the new file.',
  }),
  Object.freeze({
    id: 'tenx-outs',
    label: 'Cell Ranger outs/ folder',
    ecosystem: 'any',
    access: 'ranges',
    container: 'hdf5',
    names: Object.freeze({ folder: Object.freeze([]) }),
    writeAgain: 'Read filtered_feature_bc_matrix.h5 with scanpy (sc.read_10x_h5(path)) or Seurat (Read10X_h5(path)) and save it as .h5ad or with cellucid_prepare(), then open the new file.',
  }),
  Object.freeze({
    id: 'h5mu',
    label: 'MuData (.h5mu)',
    ecosystem: 'python',
    access: 'ranges',
    container: 'hdf5',
    names: Object.freeze({ file: Object.freeze(['.h5mu']) }),
    writeAgain: 'Write it again with mudata (mdata.write(new_path)), or serve it with cellucid serve, then open the new file.',
  }),
  Object.freeze({
    id: 'mudata-zarr',
    label: 'MuData Zarr',
    ecosystem: 'any',
    access: 'ranges',
    container: 'zarr',
    names: Object.freeze({ zip: Object.freeze([]), folder: Object.freeze([]) }),
    writeAgain: 'Write it again with mudata (mdata.write_zarr(new_path)) or cellucid_prepare(), then open the new store.',
  }),
  Object.freeze({
    id: 'rds',
    label: 'R object (.rds)',
    ecosystem: 'r',
    access: 'stream',
    container: 'rds',
    // GEO gzips supplementary files: an `.rds.gz` is `saveRDS()`'s gzip
    // stream gzipped again (or a plain one gzipped once); the content says
    // which (`formats/rds/stream.js`).
    names: Object.freeze({ file: Object.freeze(['.rds.gz', '.rds']) }),
    writeAgain: 'In R, read it (obj <- readRDS(path)) and save it again with saveRDS(obj, new_path), or write it once with cellucid::cellucid_prepare(new_path, data = obj), then open the new file.',
  }),
  Object.freeze({
    id: 'rda',
    label: 'R data (.rda, .RData)',
    ecosystem: 'r',
    access: 'stream',
    container: 'rds',
    names: Object.freeze({ file: Object.freeze(['.rdata.gz', '.rda.gz', '.rdata', '.rda']) }),
    writeAgain: 'In R, load it (load(path)) and save the object to open with saveRDS(obj, new_path), then open the new file.',
  }),
  Object.freeze({
    id: 'h5seurat',
    label: 'h5Seurat (.h5Seurat)',
    ecosystem: 'r',
    access: 'ranges',
    container: 'hdf5',
    names: Object.freeze({ file: Object.freeze(['.h5seurat']) }),
    writeAgain: 'In R, read it with SeuratDisk::LoadH5Seurat(path) and save it with saveRDS(obj, new_path), then open the new file.',
    refusal: 'This is an h5Seurat file (SeuratDisk), which Cellucid does not open. In R, read it with ' +
      'seu <- SeuratDisk::LoadH5Seurat(path) and save it with saveRDS(seu, "object.rds"), then open the .rds, ' +
      'or show it with cellucid::cellucid_view(seu).',
  }),
  Object.freeze({
    id: 'mtx',
    label: 'MatrixMarket folder',
    ecosystem: 'any',
    access: 'stream',
    container: 'text',
    names: Object.freeze({ folder: Object.freeze([]) }),
    writeAgain: 'Read it with scanpy (sc.read_10x_mtx(folder)) or Seurat (Read10X(folder)), add an embedding, and save it as .h5ad or with cellucid_prepare(), then open the new file.',
  }),
]);

const BY_ID = new Map(INPUT_FORMATS.map(format => [format.id, format]));
const LAYOUTS = Object.freeze(['file', 'zip', 'folder']);

/**
 * One format by its id.
 *
 * @param {string} id
 * @returns {Readonly<InputFormat>}
 */
export function inputFormat(id) {
  const format = BY_ID.get(id);
  if (format === undefined) throw new TypeError(`Unknown input format '${String(id)}'.`);
  return format;
}

/**
 * Whether `id` is a format id this viewer reads.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isInputFormatId(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/**
 * The layouts a format arrives in.
 *
 * @param {string} id
 * @returns {InputLayout[]}
 */
export function layoutsOf(id) {
  const { names } = inputFormat(id);
  return LAYOUTS.filter(layout => Object.hasOwn(names, layout));
}

/**
 * The longest name ending of `layouts` that `name` ends with, and its
 * format, or null.
 */
function matchName(name, layouts) {
  const lower = String(name).toLowerCase();
  let best = null;
  for (const format of INPUT_FORMATS) {
    for (const layout of layouts) {
      for (const ending of format.names[layout] ?? []) {
        if (lower.endsWith(ending) && (best === null || ending.length > best.ending.length)) {
          best = { format, layout, ending };
        }
      }
    }
  }
  return best;
}

/**
 * What one file's name says it is: its format and layout (`file` or `zip`),
 * or null for a name no format has.
 *
 * @param {string} name
 * @returns {Readonly<{format: string, layout: InputLayout}>|null}
 */
export function fileFormatOfName(name) {
  const match = matchName(name, ['file', 'zip']);
  return match === null ? null : Object.freeze({ format: match.format.id, layout: match.layout });
}

/**
 * Whether a folder's own name (a link's last path segment, `atlas.zarr`)
 * names a store folder.
 *
 * @param {string} name
 * @returns {Readonly<{format: string, layout: 'folder'}>|null}
 */
export function folderFormatOfName(name) {
  const trimmed = String(name).replace(/\/+$/, '');
  const match = matchName(trimmed, ['folder']);
  return match === null ? null : Object.freeze({ format: match.format.id, layout: 'folder' });
}

/**
 * Whether a file's name is a format's name with `.gz` added (an `.h5ad.gz`
 * as GEO ships some): a compressed copy, which cannot be read in place.
 *
 * @param {string} name
 * @returns {Readonly<{format: string, layout: InputLayout}>|null}
 */
export function compressedFormatOfName(name) {
  const text = String(name);
  return /\.gz$/i.test(text) ? fileFormatOfName(text.slice(0, -3)) : null;
}

/**
 * A dataset's name when it does not state one: its file or folder name
 * without its format's ending (`atlas.zarr.zip` is "atlas"); the name as it
 * is when nothing would be left.
 *
 * @param {string} name
 * @returns {string}
 */
export function titleOfName(name) {
  const text = String(name).replace(/\/+$/, '');
  const match = matchName(text, LAYOUTS);
  if (match === null) return text;
  const title = text.slice(0, text.length - match.ending.length);
  return title.length > 0 ? title : text;
}

/**
 * The id of a dataset that states none: `<format>_<name>`, as every
 * session saved on such a dataset records it.
 *
 * @param {string} format
 * @param {string} name - Its file or folder name
 * @returns {string}
 */
export function defaultDatasetIdOf(format, name) {
  return `${inputFormat(format).id}_${titleOfName(name)}`;
}

/**
 * The name endings of one layout, every format's, longest first within a
 * format (`file`: `.h5ad`).
 *
 * @param {InputLayout} layout
 * @returns {string[]}
 */
export function namesOfLayout(layout) {
  return INPUT_FORMATS.flatMap(format => format.names[layout] ?? []);
}

const LAYOUT_NOUNS = Object.freeze({ file: 'file', folder: 'folder', zip: 'archive' });

/**
 * What can be opened, as a message names it: one phrase per format and
 * layout, by its usual name ending (`.h5ad file`, `.zarr folder`,
 * `.zarr.zip archive`), or by its label for a folder known by its files
 * (`Cell Ranger outs/ folder`). A format known only by its content (MuData
 * Zarr, in a Zarr store's names) adds none, and a format with a `refusal`
 * (h5Seurat) none either.
 *
 * @returns {string[]}
 */
export function openableNamePhrases() {
  const phrases = [];
  for (const layout of ['file', 'folder', 'zip']) {
    for (const format of INPUT_FORMATS) {
      // Recognised only to be refused (h5Seurat): not something that opens.
      if (format.refusal !== undefined) continue;
      const names = format.names[layout];
      if (names === undefined) continue;
      if (names.length > 0) phrases.push(`${names.find(standsAlone) ?? names[0]} ${LAYOUT_NOUNS[layout]}`);
      // A folder known by the files it holds, not by its name.
      else if (layout === 'folder' && FOLDER_MARKERS[format.id] !== undefined) phrases.push(format.label);
    }
  }
  return phrases;
}

/**
 * What can be opened in some layouts, as one phrase of a message, each with
 * its article: "an .h5ad file, a .loom file, … or a .zarr.zip archive"
 * (`openableNamePhrases`, so every message names what the registry
 * opens, never a list written by hand).
 *
 * @param {{layouts?: ReadonlyArray<'file'|'folder'|'zip'>, conjunction?: string}} [options]
 * @returns {string}
 */
export function openableNamesText({ layouts = ['file', 'folder', 'zip'], conjunction = 'or' } = {}) {
  const nouns = new Set(layouts.map(layout => LAYOUT_NOUNS[layout]));
  const phrases = openableNamePhrases()
    .filter(phrase => nouns.has(phrase.slice(phrase.lastIndexOf(' ') + 1)))
    // "an" before a name read letter by letter (.h5ad, .rds) or a vowel.
    .map(phrase => `${/^\.(h5|r|[aeiou])/i.test(phrase) ? 'an' : 'a'} ${phrase}`);
  return phrases.length < 2 ? phrases.join('') : `${phrases.slice(0, -1).join(', ')} ${conjunction} ${phrases.at(-1)}`;
}

/** Every single-file name ending (`file` and `zip` layouts). */
function fileEndings() {
  return INPUT_FORMATS.flatMap(format => ['file', 'zip'].flatMap(layout => format.names[layout] ?? []));
}

/**
 * Whether a name ending stands for its format on its own: one part
 * (`.h5ad`), or several whose last part is an ending of its own
 * (`.zarr.zip`, a `.zip`). A compressed copy's ending (`.rds.gz`: `.gz` is
 * no format's) does not.
 *
 * @param {string} ending
 * @returns {boolean}
 */
function standsAlone(ending) {
  const last = ending.slice(ending.lastIndexOf('.'));
  return last === ending || namesOfLayout('file').concat(namesOfLayout('zip')).includes(last);
}

/**
 * The `accept` list of the File… picker: every single-file name ending, in
 * the shortest form that names only its format. A two-part ending whose
 * last part is an ending of its own is offered by that part (`.zip` covers
 * `.zarr.zip`); one whose last part is not (`.rds.gz`) is offered whole,
 * never as its last part: a bare `.gz` would offer every gzip file. A
 * browser whose file dialog matches only last extensions may grey such a
 * file out; dropping it, or its link, opens it all the same, and a picked
 * file is checked by its whole name (`fileFormatOfName`).
 *
 * @returns {string}
 */
export function filePickerAccept() {
  const all = fileEndings();
  const endings = new Set();
  for (const ending of all) {
    const last = ending.slice(ending.lastIndexOf('.'));
    if (last === ending || all.includes(last)) endings.add(last);
    else endings.add(ending);
  }
  return [...endings].join(',');
}

/**
 * Whether a list of paths (a picked or dropped folder's files, each
 * `<folder>/<path inside>`) is one format's folder: a folder's name names
 * one (`.zarr`), or it holds one of a format's marker files
 * (`FOLDER_MARKERS`, tried in registry order).
 *
 * @param {Iterable<string>} paths
 * @returns {Readonly<{format: string, layout: 'folder'}>|null}
 */
export function folderFormatOfPaths(paths) {
  const split = [...paths].map(path => String(path).replace(/\\/g, '/').split('/'));
  for (const parts of split) {
    for (let index = 0; index < parts.length - 1; index++) {
      const named = folderFormatOfName(parts[index]);
      if (named !== null) return named;
    }
  }
  const leaves = new Set(split.map(parts => parts.at(-1)));
  for (const format of INPUT_FORMATS) {
    const markers = FOLDER_MARKERS[format.id];
    if (markers !== undefined && markers.some(marker => leaves.has(marker))) {
      return Object.freeze({ format: format.id, layout: 'folder' });
    }
    if (markers !== undefined && FOLDER_MARKER_PREFIXES[format.id] !== undefined &&
        hasPrefixedMarker(split, markers, FOLDER_MARKER_PREFIXES[format.id])) {
      return Object.freeze({ format: format.id, layout: 'folder' });
    }
  }
  return null;
}

/**
 * Whether one folder of the list holds a marker under a prefix that ends
 * with one of `separators`, and another file whose name starts with the
 * prefix's first part.
 */
function hasPrefixedMarker(split, markers, separators) {
  const byFolder = new Map();
  for (const parts of split) {
    const folder = parts.slice(0, -1).join('/');
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(parts.at(-1));
  }
  for (const names of byFolder.values()) {
    for (const name of names) {
      for (const marker of markers) {
        if (name.length <= marker.length || !name.endsWith(marker)) continue;
        const prefix = name.slice(0, name.length - marker.length);
        if (!separators.includes(prefix.at(-1))) continue;
        let cut = 0;
        while (cut < prefix.length && !separators.includes(prefix[cut])) cut++;
        const first = prefix.slice(0, cut + 1);
        if (names.some(other => other !== name && other.startsWith(first))) return true;
      }
    }
  }
  return false;
}

/** The marker files of one format's folders (`zarr`: `.zgroup`, `zarr.json`, …). */
export function folderMarkersOf(format) {
  return FOLDER_MARKERS[format] ?? Object.freeze([]);
}

/**
 * How many leading bytes `layoutOfHead` needs.
 */
export const SIGNATURE_BYTES = Math.max(...SIGNATURES.map(item => Math.max(...item.offsets) + item.hex.length / 2));

/**
 * What a file's first bytes make it: its layout and container, or null when
 * they carry no signature (or are not at hand).
 *
 * @param {Uint8Array|null} head
 * @returns {Readonly<{layout: InputLayout, container: InputContainer}>|null}
 */
export function layoutOfHead(head) {
  if (!(head instanceof Uint8Array)) return null;
  for (const signature of SIGNATURES) {
    const length = signature.hex.length / 2;
    for (const offset of signature.offsets) {
      if (head.length < offset + length) continue;
      let matches = true;
      for (let index = 0; index < length && matches; index++) {
        matches = head[offset + index] === parseInt(signature.hex.slice(index * 2, index * 2 + 2), 16);
      }
      if (matches) return Object.freeze({ layout: signature.layout, container: signature.container });
    }
  }
  return null;
}

/**
 * Whether a remote file's first read is its head (`HEAD_BYTES`, read beside
 * the probe of its size): a container whose structure starts at byte 0
 * (HDF5) is; a ZIP archive, read from its end, is not.
 *
 * @param {Readonly<{format: string, layout: InputLayout}>|null} named
 * @returns {boolean}
 */
export function readsFromHead(named) {
  return named !== null && named.layout === 'file' && inputFormat(named.format).container === 'hdf5';
}

/**
 * The registry as plain data: what `tests/fixtures/input-formats.json`
 * holds, and what Python and R read.
 *
 * @returns {Object}
 */
export function inputFormatsDocument() {
  return {
    schema: INPUT_FORMATS_SCHEMA,
    signatures: SIGNATURES.map(item => ({ ...item, offsets: [...item.offsets] })),
    folderMarkers: Object.fromEntries(Object.entries(FOLDER_MARKERS).map(([key, value]) => [key, [...value]])),
    folderMarkerPrefixes: { ...FOLDER_MARKER_PREFIXES },
    formats: INPUT_FORMATS.map(format => ({
      id: format.id,
      label: format.label,
      ecosystem: format.ecosystem,
      access: format.access,
      container: format.container,
      names: Object.fromEntries(Object.entries(format.names).map(([key, value]) => [key, [...value]])),
      ...(format.refusal === undefined ? {} : { refusal: format.refusal }),
    })),
  };
}

/**
 * `inputFormatsDocument()` as the exact bytes of `input-formats.json`.
 *
 * @returns {string}
 */
export function inputFormatsJson() {
  return `${JSON.stringify(inputFormatsDocument(), null, 2)}\n`;
}
