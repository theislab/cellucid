"""The stored layout of a file, read with the format's own library: where every
chunk of every array lies and how many bytes it takes, as the floor of
`scripts/efficiency-floor.mjs` needs it.

    python -I scripts/efficiency-floor/layout.py FILE_OR_FOLDER OUT.json [--content DIR]

For an HDF5 file (``.h5ad``, ``.h5mu``, ``.loom``, a 10x ``.h5``) h5py reports
each chunk's byte offset and stored size (``chunk_iter``), a contiguous
dataset its offset and size, a compact one none (its bytes are in its object
header). For a Zarr store (v2 or v3), each chunk is a file of the folder, or
an entry of the ``.zarr.zip``: its stored bytes are the entry's local header
plus its data, at the entry's offset in the archive. A sharded v3 array's
chunks are its inner chunks, each at the place its shard's index gives (in
the shard file, or in the archive); the shard indexes are metadata. Metadata documents
(``.zarray``, ``.zattrs``, ``.zgroup``, ``.zmetadata``, ``zarr.json``) are listed
with their sizes.

``--content DIR`` also writes the arrays a floor needs the values of: every
sparse matrix's ``indptr`` and ``indices``, a priority file's
``obs/cellucid_original_position`` and ``varm/cellucid_prefix_counts``,
as raw little-endian files under DIR named by the array's path, with their
dtype in the layout (``content``). Nothing here reads through Cellucid: the
floor is computed from this, independently of the reader it measures.
"""

from __future__ import annotations

import argparse
import json
import struct
import zipfile
from pathlib import Path

import h5py
import numpy as np

CONTENT_NAMES = ("indptr", "indices", "codes", "cellucid_original_position", "cellucid_prefix_counts")


def _content_wanted(path: str) -> bool:
    return path.rsplit("/", 1)[-1] in CONTENT_NAMES


def _dump(content_dir: Path | None, path: str, values: np.ndarray, record: dict) -> None:
    if content_dir is None or not _content_wanted(path):
        return
    target = content_dir / (path.strip("/").replace("/", "__") + ".bin")
    target.parent.mkdir(parents=True, exist_ok=True)
    little = values.astype(values.dtype.newbyteorder("<"), copy=False)
    little.tofile(target)
    record["content"] = {"file": target.name, "dtype": little.dtype.str, "shape": list(values.shape)}


# --------------------------------------------------------------------- HDF5


def hdf5_layout(path: Path, content_dir: Path | None) -> dict:
    arrays: dict[str, dict] = {}
    with h5py.File(path, "r") as file:
        def visit(name: str, node) -> None:
            if not isinstance(node, h5py.Dataset):
                return
            record: dict = {
                "shape": list(node.shape),
                "dtype": node.dtype.str if node.dtype.kind != "O" else "vlen",
                "itemsize": int(node.dtype.itemsize),
                "filters": [str(f) for f in (node.compression,) if f] + (["shuffle"] if node.shuffle else []),
            }
            if node.dtype.kind == "O" and node.ndim == 1 and node.shape[0] > 0:
                # A string's bytes are a global heap object: 16 bytes of header
                # and the string padded to 8 (libhdf5's layout).
                lengths = np.fromiter((len(v) if isinstance(v, bytes) else len(str(v).encode()) for v in node[()]), dtype=np.int64)
                record["heapBytesPerElement"] = float(np.mean(16 + 8 * np.ceil(lengths / 8)))
            layout = node.id.get_create_plist().get_layout()
            if layout == h5py.h5d.CHUNKED:
                record["layout"] = "chunked"
                record["chunks"] = list(node.chunks)
                chunks = []

                def chunk(info) -> None:
                    chunks.append([list(info.chunk_offset), int(info.byte_offset), int(info.size)])

                if node.id.get_num_chunks() > 0:
                    node.id.chunk_iter(chunk)
                record["chunkMap"] = chunks
            elif layout == h5py.h5d.CONTIGUOUS:
                record["layout"] = "contiguous"
                offset = node.id.get_offset()
                record["extent"] = [None if offset is None else int(offset), int(node.id.get_storage_size())]
            else:
                record["layout"] = "compact"
            if content_dir is not None and _content_wanted(name):
                _dump(content_dir, name, node[()], record)
            arrays["/" + name] = record

        file.visititems(visit)
    return {"kind": "hdf5", "bytes": path.stat().st_size, "arrays": arrays}


# --------------------------------------------------------------------- Zarr


def _zip_entries(path: Path) -> dict[str, tuple[int, int]]:
    """Each entry's byte range in the archive: its local header and data."""
    entries = {}
    with zipfile.ZipFile(path) as archive, path.open("rb") as raw:
        for info in archive.infolist():
            raw.seek(info.header_offset)
            header = raw.read(30)
            name_length, extra_length = struct.unpack("<HH", header[26:30])
            start = info.header_offset
            entries[info.filename] = (start, 30 + name_length + extra_length + info.compress_size)
    return entries


def _zip_data_starts(path: Path) -> dict[str, int]:
    """Each entry's data offset in the archive (after its local header)."""
    starts = {}
    with zipfile.ZipFile(path) as archive, path.open("rb") as raw:
        for info in archive.infolist():
            raw.seek(info.header_offset)
            header = raw.read(30)
            name_length, extra_length = struct.unpack("<HH", header[26:30])
            starts[info.filename] = info.header_offset + 30 + name_length + extra_length
    return starts


def _shard_index(data: bytes, count: int, at_end: bool, checksum: bool) -> list[tuple[int, int] | None]:
    """A shard's index (Zarr v3 `sharding_indexed`): each inner chunk's
    offset and size in the shard, None for one never written."""
    size = 16 * count + (4 if checksum else 0)
    index = data[len(data) - size:] if at_end else data[:size]
    pairs = np.frombuffer(index[: 16 * count], dtype="<u8").reshape(count, 2)
    empty = np.iinfo(np.uint64).max
    return [None if offset == empty and length == empty else (int(offset), int(length)) for offset, length in pairs]


def zarr_layout(path: Path, content_dir: Path | None) -> dict:
    import zarr

    zipped = path.is_file()
    archive = None
    if zipped:
        entries = _zip_entries(path)
        store = zarr.storage.ZipStore(path, mode="r")
        keys = {name: [offset, size] for name, (offset, size) in entries.items()}
        data_starts = _zip_data_starts(path)
        archive = zipfile.ZipFile(path)
    else:
        store = zarr.storage.LocalStore(path, read_only=True)
        keys = {
            str(p.relative_to(path)).replace("\\", "/"): [None, p.stat().st_size]
            for p in path.rglob("*")
            if p.is_file()
        }
    root = zarr.open_group(store, mode="r")
    arrays: dict[str, dict] = {}

    def zipped_bytes(key: str) -> bytes:
        return archive.read(key)
    metadata = {
        key: value for key, value in keys.items()
        if key.rsplit("/", 1)[-1] in (".zarray", ".zattrs", ".zgroup", ".zmetadata", "zarr.json")
    }

    def walk(group, prefix: str) -> None:
        for name, node in group.members():
            node_path = f"{prefix}{name}"
            if isinstance(node, zarr.Group):
                walk(node, node_path + "/")
                continue
            meta = node.metadata
            record: dict = {
                "shape": list(node.shape),
                "dtype": str(node.dtype),
                "chunks": list(node.chunks),
                "zarrFormat": meta.zarr_format,
                "layout": "chunked",
            }
            if meta.zarr_format == 2:
                separator = getattr(meta, "dimension_separator", ".") or "."
                record["codecs"] = [repr(meta.compressor)] + [repr(f) for f in (meta.filters or [])]
                record["order"] = meta.order

                def key_of(index, separator=separator, node_path=node_path) -> str:
                    return f"{node_path}/" + (separator.join(str(i) for i in index) if index else "0")
            else:
                record["codecs"] = [type(codec).__name__ for codec in meta.codecs]
                encoding = meta.chunk_key_encoding

                def key_of(index, encoding=encoding, node_path=node_path) -> str:
                    return f"{node_path}/" + encoding.encode_chunk_key(tuple(index))
            sharding = None
            if meta.zarr_format == 3 and type(meta.codecs[0]).__name__ == "ShardingCodec":
                sharding = meta.codecs[0]
                # What decodes an inner chunk (the floor's codec rate), and the shard shape.
                record["codecs"] = [repr(codec) for codec in sharding.codecs]
                record["shards"] = list(meta.chunk_grid.chunk_shape)
            grid = [-(-s // c) if c else 0 for s, c in zip(node.shape, node.chunks, strict=True)]
            chunks = []
            if sharding is None:
                for index in np.ndindex(*grid) if grid else [()]:
                    key = key_of(index)
                    if key in keys:
                        offset, size = keys[key]
                        chunks.append([[i * c for i, c in zip(index, node.chunks, strict=True)], offset, size, key])
            else:
                # Each inner chunk where its shard's index puts it: in the
                # shard file (a folder: offset in the file) or the archive
                # (offset of the shard's data plus its place in the shard).
                per = [o // c for o, c in zip(record["shards"], node.chunks, strict=True)]
                at_end = sharding.index_location.value == "end" if hasattr(sharding.index_location, "value") else sharding.index_location == "end"
                checksum = any(type(codec).__name__ == "Crc32cCodec" for codec in sharding.index_codecs)
                shard_grid = [-(-s // o) for s, o in zip(node.shape, record["shards"], strict=True)]
                for shard in np.ndindex(*shard_grid):
                    key = key_of(shard)
                    if key not in keys:
                        continue
                    data = (zipped_bytes(key) if zipped else (path / key).read_bytes())
                    index = _shard_index(data, int(np.prod(per)), at_end, checksum)
                    base = data_starts[key] if zipped else 0
                    for local, inner in enumerate(np.ndindex(*per)):
                        if index[local] is None:
                            continue
                        coords = [(s * p + i) * c for s, p, i, c in zip(shard, per, inner, node.chunks, strict=True)]
                        if any(coord >= extent for coord, extent in zip(coords, node.shape, strict=True)):
                            continue
                        offset, size = index[local]
                        chunks.append([coords, base + offset, size, key])
            record["chunkMap"] = chunks
            if content_dir is not None and _content_wanted(node_path):
                _dump(content_dir, node_path, node[...], record)
            arrays["/" + node_path] = record

    walk(root, "")
    total = path.stat().st_size if zipped else sum(size for _, size in keys.values())
    return {"kind": "zarr-zip" if zipped else "zarr", "bytes": total, "arrays": arrays, "metadata": metadata}


def layout_of(path: Path, content_dir: Path | None = None) -> dict:
    if path.is_dir() or path.name.endswith(".zip"):
        return zarr_layout(path, content_dir)
    return hdf5_layout(path, content_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--content", type=Path, default=None)
    args = parser.parse_args()
    args.out.write_text(json.dumps(layout_of(args.path, args.content)))


if __name__ == "__main__":
    main()
