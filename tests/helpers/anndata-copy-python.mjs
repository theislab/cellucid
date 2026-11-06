/**
 * Python's side of the copy tests (`data/anndata/write/copy.js`): where this
 * machine has a Python with anndata, mudata and zarr (the workspace's
 * environment, `.environments/python/venv`, or `python3`) and the
 * cellucid-python checkout (`CELLUCID_PYTHON_ROOT`, else the one beside this
 * checkout), `compareInPython(cases)` reads each copy with anndata (mudata
 * for a MuData), compares every element with what Python reads from its
 * source, and asks cellucid-python what it makes of the copy. Used by
 * `tests/anndata-copy-cross-language.test.mjs` and the browser spec that
 * hands Python the bytes a browser wrote (`tests/browser/anndata-copy.spec.mjs`).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The workspace folder: the checkout's parent (a worktree's is four levels further down). */
const WORKSPACE = (() => {
  for (let folder = REPOSITORY; folder !== path.dirname(folder); folder = path.dirname(folder)) {
    if (existsSync(path.join(folder, 'cellucid-python')) && existsSync(path.join(folder, 'cellucid'))) return folder;
  }
  return path.resolve(REPOSITORY, '..');
})();
export const PYTHON_ROOT = process.env.CELLUCID_PYTHON_ROOT ?? path.join(WORKSPACE, 'cellucid-python');
export const PYTHON = [path.join(WORKSPACE, '.environments/python/venv/bin/python'), 'python3'].find(candidate => {
  if (candidate.includes('/') && !existsSync(candidate)) return false;
  return spawnSync(candidate, ['-c', 'import anndata, mudata, zarr'], { encoding: 'utf8' }).status === 0;
});
/** Why the Python checks cannot run here, or false. */
export const SKIP = PYTHON === undefined
  ? 'no Python with anndata, mudata and zarr on this machine'
  : !existsSync(path.join(PYTHON_ROOT, 'src/cellucid/__init__.py')) ? `no cellucid-python checkout at ${PYTHON_ROOT}` : false;

/** Run `script` with the JSON `input` on stdin and cellucid-python's sources first on the path; its JSON answer. */
export function python(script, input) {
  // `-I` ignores PYTHONPATH (and leaves this folder off the path), so the sources go first from inside.
  const sources = `import sys; sys.path.insert(0, ${JSON.stringify(path.join(PYTHON_ROOT, 'src'))})\n`;
  const run = spawnSync(PYTHON, ['-I', '-W', 'ignore', '-c', sources + script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

/** Python's reading and comparison of each copy with its source. */
const COMPARE = String.raw`
import json, sys, math, zipfile
import numpy as np, pandas as pd, scipy.sparse as sp
import anndata, mudata, zarr
from cellucid._anndata_files import ANNDATA_KINDS, MUDATA_KINDS, classify_anndata_path, read_cellucid_identity
from cellucid.prepare_data._priority import stored_order_of
from cellucid import history_applied

def store(path):
    return zarr.storage.ZipStore(path, mode="r")

def zip_group(path):
    # A zipped store sits at the archive's top, or inside its one folder (a zipped .zarr folder).
    names = zipfile.ZipFile(path).namelist()
    if any(name in (".zgroup", ".zmetadata", "zarr.json") for name in names):
        return store(path)
    return zarr.open_group(store(path), mode="r", path=names[0].split("/")[0])

def read(path, kind):
    if kind == "h5ad": return anndata.read_h5ad(path)
    if kind == "h5mu": return mudata.read_h5mu(path)
    if kind == "mudata-zip": return mudata.read_zarr(zip_group(path))
    if kind == "loom": return anndata.read_loom(path)
    return anndata.read_zarr(zip_group(path))

def native(dtype):
    # Numbers in the host's byte order; text (new-style string dtypes) as it is.
    return dtype.newbyteorder("=") if isinstance(dtype, np.dtype) and dtype.kind in "biufc" else dtype

def dense(x):
    if sp.issparse(x): return x.toarray()
    return np.asarray(x)

def same(a, b, where):
    if isinstance(a, (anndata.AnnData,)):
        compare_anndata(a, b, where); return
    if isinstance(a, dict) or hasattr(a, "keys") and not isinstance(a, (pd.DataFrame, np.ndarray)):
        assert set(a.keys()) == set(b.keys()), f"{where}: keys {sorted(a.keys())} != {sorted(b.keys())}"
        for key in a.keys(): same(a[key], b[key], f"{where}/{key}")
        return
    if isinstance(a, pd.DataFrame):
        if OLDER:
            # A file of anndata before 0.8 whose column-order lists only some of its columns
            # (SeuratDisk): anndata reads the listed ones, the reader presents every one, the copy keeps them all.
            b = b[[column for column in b.columns if column in a.columns]]
        assert list(a.columns) == list(b.columns), f"{where}: columns {list(a.columns)} != {list(b.columns)}"
        assert list(map(str, a.index)) == list(map(str, b.index)), f"{where}: index"
        for column in a.columns: same_series(a[column], b[column], f"{where}[{column}]")
        return
    if sp.issparse(a) or sp.issparse(b) or isinstance(a, np.ndarray):
        if isinstance(a, np.ndarray) and a.dtype.names is not None:
            assert a.dtype.names == b.dtype.names, f"{where}: record fields"
            for name in a.dtype.names: same(np.asarray(a[name]), np.asarray(b[name]), f"{where}.{name}")
            return
        x, y = dense(a), dense(b)
        # A file of anndata before 0.8 stores a scalar of uns as a one-element
        # array; the reader presents the current layout's scalar, which the copy writes.
        if OLDER and x.shape == (1,) and y.shape == ():
            x = x.reshape(())
        assert x.shape == y.shape, f"{where}: shape {x.shape} != {y.shape}"
        if x.dtype.kind in "SUO" or y.dtype.kind in "SUO":
            text = lambda v: v.decode() if isinstance(v, bytes) else str(v)
            assert [text(v) for v in x.ravel()] == [text(v) for v in y.ravel()], f"{where}: text"
            return
        # The same type; the copy stores it in little-endian order, as anndata writes one.
        assert native(x.dtype) == native(y.dtype), f"{where}: dtype {x.dtype} != {y.dtype}"
        assert np.array_equal(x, y, equal_nan=x.dtype.kind in "fc"), f"{where}: values"
        return
    if isinstance(a, float) and math.isnan(a):
        assert isinstance(b, float) and math.isnan(b), f"{where}"; return
    assert a == b or str(a) == str(b), f"{where}: {a!r} != {b!r}"

def same_series(a, b, where):
    if isinstance(a.dtype, pd.CategoricalDtype):
        assert isinstance(b.dtype, pd.CategoricalDtype), f"{where}: categorical"
        assert list(a.cat.categories) == list(b.cat.categories), f"{where}: categories"
        assert a.cat.ordered == b.cat.ordered, f"{where}: ordered"
        assert np.array_equal(a.cat.codes.to_numpy(), b.cat.codes.to_numpy()), f"{where}: codes"
        return
    assert str(native(a.dtype)) == str(native(b.dtype)), f"{where}: dtype {a.dtype} != {b.dtype}"
    assert a.isna().equals(b.isna()), f"{where}: missing values"
    assert a[a.notna()].astype(object).tolist() == b[b.notna()].astype(object).tolist(), f"{where}: values"

def compare_anndata(a, b, where):
    assert a.shape == b.shape, f"{where}: shape {a.shape} != {b.shape}"
    same(a.obs, b.obs, f"{where}.obs"); same(a.var, b.var, f"{where}.var")
    if a.X is None: assert b.X is None, f"{where}.X"
    else: same(a.X, b.X, f"{where}.X")
    for element in ("obsm", "obsp", "varm", "varp", "layers"):
        same(dict(getattr(a, element)), dict(getattr(b, element)), f"{where}.{element}")
    if a.raw is None: assert b.raw is None, f"{where}.raw"
    else:
        same(a.raw.X, b.raw.X, f"{where}.raw.X"); same(a.raw.var, b.raw.var, f"{where}.raw.var")
    same(dict(a.uns), dict(b.uns), f"{where}.uns")

checked = []
OLDER = False
for case in json.load(sys.stdin):
    OLDER = case.get("older", False)
    source = read(case["source"], case["kind"])
    copy = mudata.read_zarr(store(case["copy"])) if case["mudata"] else anndata.read_zarr(store(case["copy"]))
    # What the copy's changes wrote is read back first, then set aside: the rest equals the source.
    history = history_applied(copy) if case.get("history") else None
    # Keys the copy wrote into uns['cellucid'] (its changes, the dataset's names where the source had none).
    source_record = source.uns.get("cellucid", {}) if hasattr(source, "uns") else {}
    for key in case.get("written", []):
        if key not in source_record or key in case.get("changed", []): copy.uns.get("cellucid", {}).pop(key, None)
    if "cellucid" in copy.uns and not copy.uns["cellucid"] and "cellucid" not in source.uns: del copy.uns["cellucid"]
    added = {}
    for column in case.get("added_obs", []):
        added[column] = [None if value != value else value for value in copy.obs[column].astype(object).tolist()]
        copy.obs = copy.obs.drop(columns=[column])
    if case["mudata"]:
        assert list(source.mod.keys()) == list(copy.mod.keys()), "modalities"
        for name in source.mod: compare_anndata(source.mod[name], copy.mod[name], f"{case['name']}:{name}")
        same(source.obs[[c for c in source.obs.columns if ":" not in c]], copy.obs[[c for c in copy.obs.columns if ":" not in c]], f"{case['name']}.obs")
    elif isinstance(source, mudata.MuData):
        raise AssertionError("a MuData source copied as AnnData")
    else:
        compare_anndata(source, copy, case["name"])
    stored = classify_anndata_path(case["copy"])
    identity = read_cellucid_identity(stored)
    entry = {"added": {key: [v if not isinstance(v, (np.generic,)) else v.item() for v in values] for key, values in added.items()},
             "name": case["name"], "kind": "mudata" if stored.kind in MUDATA_KINDS else "anndata" if stored.kind in ANNDATA_KINDS else stored.kind,
             "layout": stored.layout, "identity": list(identity)}
    if case.get("priority"):
        order = stored_order_of(copy)
        entry["priority"] = {"verified": order.positions is not None, "notice": order.notice}
    if case.get("history"):
        entry["history"] = history
    checked.append(entry)
print(json.dumps(checked, default=str))
`;

/**
 * Compare each copy with its source in Python: `cases` of `{name, source,
 * copy, kind, mudata, priority?, history?, older?, written?, added_obs?}`
 * (`kind`: how Python reads the source: `h5ad`, `zarr-zip`, `h5mu`,
 * `mudata-zip`, `loom`; `written`: `uns['cellucid']` keys the copy wrote,
 * set aside; `added_obs`: obs columns the copy added, answered as `added`
 * in the copy's row order and set aside).
 *
 * @returns {Array<{name: string, kind: string, layout: string, identity: Array, priority?: Object, history?: Array}>}
 */
export function compareInPython(cases) {
  const checked = python(COMPARE, cases);
  assert.equal(checked.length, cases.length, 'every copy was read and compared');
  return checked;
}
