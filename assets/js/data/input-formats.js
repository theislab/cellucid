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
 *   folder, a `.zarr.zip`) or `folder` (a store folder: picked, dropped, or
 *   on a web host).
 * - A **container** is what the reader opens the bytes with: `hdf5`
 *   (`formats/hdf5`) or `zarr` (`formats/zarr`, over a folder, a ZIP archive
 *   or a web host).
 * - A **format** is what the container holds, by its id: `h5ad`, `zarr`. The
 *   id is stable: sessions (a dataset that states no id is
 *   `<format>_<name>`), a server's `anndata.file.kind`, its health `format`,
 *   and the tests name it.
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
 * @typedef {'hdf5'|'zarr'} InputContainer
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
 *   longest first (a folder's are its own name's endings)
 * @property {string} writeAgain - What to do with a file the browser cannot
 *   read, in the words of the tools that write the format
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
 * The files that make a folder (or the folder inside a ZIP archive) a store
 * of one container: any one of them, at the folder's root or below it.
 */
const FOLDER_MARKERS = Object.freeze({
  zarr: Object.freeze(['.zarray', '.zattrs', '.zgroup', '.zmetadata', 'zarr.json']),
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

/** The format of one container, or null. */
function formatOfContainer(container) {
  return INPUT_FORMATS.find(format => format.container === container) ?? null;
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
 * `.zarr.zip archive`).
 *
 * @returns {string[]}
 */
export function openableNamePhrases() {
  const phrases = [];
  for (const layout of ['file', 'folder', 'zip']) {
    for (const format of INPUT_FORMATS) {
      const names = format.names[layout];
      if (names !== undefined) phrases.push(`${names[0]} ${LAYOUT_NOUNS[layout]}`);
    }
  }
  return phrases;
}

/**
 * The `accept` list of the File… picker: every single-file name ending,
 * shortest form (`.zip` covers `.zarr.zip`).
 *
 * @returns {string}
 */
export function filePickerAccept() {
  const endings = new Set();
  for (const format of INPUT_FORMATS) {
    for (const layout of ['file', 'zip']) {
      for (const ending of format.names[layout] ?? []) {
        endings.add(ending.slice(ending.lastIndexOf('.')));
      }
    }
  }
  return [...endings].join(',');
}

/**
 * Whether a list of paths (a picked or dropped folder's files, each
 * `<folder>/<path inside>`) is a store folder: the folder's name names one,
 * or it holds one of a container's marker files.
 *
 * @param {Iterable<string>} paths
 * @returns {Readonly<{format: string, layout: 'folder'}>|null}
 */
export function folderFormatOfPaths(paths) {
  for (const path of paths) {
    const parts = String(path).replace(/\\/g, '/').split('/');
    for (let index = 0; index < parts.length - 1; index++) {
      const named = folderFormatOfName(parts[index]);
      if (named !== null) return named;
    }
    const leaf = parts.at(-1);
    for (const [container, markers] of Object.entries(FOLDER_MARKERS)) {
      const format = formatOfContainer(container);
      if (format !== null && markers.includes(leaf)) {
        return Object.freeze({ format: format.id, layout: 'folder' });
      }
    }
  }
  return null;
}

/** The marker files of one container (`zarr`: `.zgroup`, `zarr.json`, …). */
export function folderMarkersOf(container) {
  return FOLDER_MARKERS[container] ?? Object.freeze([]);
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
 * The format one opened container holds, given the layout it arrived in.
 *
 * @param {InputContainer} container
 * @param {InputLayout} layout
 * @returns {Readonly<InputFormat>}
 */
export function formatOfOpenedContainer(container, layout) {
  const format = INPUT_FORMATS.find(item => item.container === container && Object.hasOwn(item.names, layout));
  if (format === undefined) {
    throw new TypeError(`No input format is a ${container} container in a ${layout} layout.`);
  }
  return format;
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
    formats: INPUT_FORMATS.map(format => ({
      id: format.id,
      label: format.label,
      ecosystem: format.ecosystem,
      access: format.access,
      container: format.container,
      names: Object.fromEntries(Object.entries(format.names).map(([key, value]) => [key, [...value]])),
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
