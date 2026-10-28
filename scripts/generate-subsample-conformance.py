"""Write the subsampling conformance fixture the web app, Python and R are checked against.

``tests/fixtures/subsample-conformance.json`` holds subsample requests and the
cells each keeps, computed here by a plain-Python reading of the subsampling
specification (``cellucid-python/docs/user_guide/web_app/p_developer_docs/
subsampling_specification.md``), independently of the three implementations:
the web app's ``assets/js/data/subsample.js``
(``tests/subsample-conformance.test.mjs``), ``cellucid.subsample_cells``
(cellucid-python ``tests/fixtures/subsample_conformance.json``) and
``cellucid_subsample_cells()`` (cellucid-r
``tests/testthat/fixtures/subsample_conformance.json``). The three copies are
byte-identical and pinned by the same SHA-256.

What it holds:

- ``rank``: the rank of chosen positions under chosen seeds, up to 2^32 - 1;
- ``fraction``: subsample sizes of fractions;
- ``cases``: one per method and edge, with the kept positions (or, for the
  one large case, the first and last ones), their count and cell-set digest,
  and the kept positions in priority order (``order``; ``orderHead`` and
  ``orderTail`` for the large case): the order a subsample's cells are
  opened in, and the positions a session saved on it holds its per-cell
  state in;
- ``encoding``: a cell set's session bytes (LEB128 gaps), as hex.

Every input is drawn from seeded generators, so every run writes the same bytes.

Run from the repository root::

    python scripts/generate-subsample-conformance.py          # write
    python scripts/generate-subsample-conformance.py --check  # compare
"""

from __future__ import annotations

import argparse
import json
import math
from fractions import Fraction
import struct
import sys
from pathlib import Path

TARGET = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "subsample-conformance.json"
M32 = 0xFFFFFFFF


def fmix32(h: int) -> int:
    h &= M32
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & M32
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & M32
    h ^= h >> 16
    return h


def seed_key(seed: int) -> int:
    return fmix32(seed ^ 0x9E3779B9)


def rank(seed: int, position: int) -> int:
    return fmix32(position ^ seed_key(seed))


def count_from_share(share: Fraction, n_obs: int) -> int:
    """round-half-up(n_obs * share), exactly; at least 1, at most n_obs."""
    k = (2 * n_obs * share.numerator + share.denominator) // (2 * share.denominator)
    return min(n_obs, max(1, k))


def count_from_fraction(fraction: float, n_obs: int) -> int:
    """A fraction is the rational of its shortest round-trip decimal (repr)."""
    return count_from_share(Fraction(repr(float(fraction))), n_obs)


def count_from_percent(percent: str, n_obs: int) -> int:
    """A percentage is the rational its decimal text names, over 100."""
    return count_from_share(Fraction(percent) / 100, n_obs)


def lowest(items: list[int], k: int, seed: int) -> list[int]:
    """The ``k`` items of lowest rank, ties (never) by item."""
    return sorted(sorted(items, key=lambda item: (rank(seed, item), item))[:k])


def uniform(n_obs: int, k: int, seed: int) -> list[int] | None:
    if k >= n_obs:
        return None
    return lowest(list(range(n_obs)), k, seed)


def blocks(n_obs: int, k: int, seed: int, block_size: int) -> list[int] | None:
    if k >= n_obs:
        return None
    count = -(-n_obs // block_size)
    order = sorted(range(count), key=lambda block: (rank(seed, block), block))
    kept: list[int] = []
    for block in order:
        if len(kept) == k:
            break
        start = block * block_size
        size = min(block_size, n_obs - start)
        kept.extend(range(start, start + min(size, k - len(kept))))
    return sorted(kept)


def priority_order(request: dict, kept: list[int]) -> list[int]:
    """The kept positions in priority order: ``blocks`` by the rank of
    their block number, positions ascending within a block; every other
    method by rank under its seed (ranks never tie)."""
    seed = request["seed"]
    if request["method"] == "blocks":
        size = request["blockSize"]
        return sorted(kept, key=lambda p: (rank(seed, p // size), p))
    return sorted(kept, key=lambda p: rank(seed, p))


def allocate(capacity: list[int], total: int, allocation: str) -> list[int]:
    if total == 0 or not capacity:
        return [0] * len(capacity)
    whole = sum(capacity)
    if allocation == "proportional":
        out = [total * c // whole for c in capacity]
        remainder = [total * c % whole for c in capacity]
        order = sorted(range(len(capacity)), key=lambda s: (-remainder[s], s))
        for s in order[: total - sum(out)]:
            out[s] += 1
        return out
    # balanced: the highest level L with sum(min(c, L)) <= total, then one
    # more to the earliest strata holding more than L.
    lo, hi = 0, max(capacity)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if sum(min(c, mid) for c in capacity) <= total:
            lo = mid
        else:
            hi = mid - 1
    out = [min(c, lo) for c in capacity]
    left = total - sum(out)
    for s, c in enumerate(capacity):
        if left == 0:
            break
        if c > lo:
            out[s] += 1
            left -= 1
    return out


def split_over_strata(strata: list[int], n_strata: int, k: int, seed: int, allocation: str, minimum: int) -> list[int]:
    sizes = [0] * n_strata
    for s in strata:
        sizes[s] += 1
    occupied = [s for s in range(n_strata) if sizes[s] > 0]
    base = [min(minimum, sizes[s]) for s in occupied]
    capacity = [sizes[s] - b for s, b in zip(occupied, base)]
    if sum(base) > k:
        raise ValueError("minimum per category does not fit")
    positive = [c for c in capacity if c > 0]
    extra = iter(allocate(positive, k - sum(base), allocation))
    quota = {s: b + (next(extra) if c > 0 else 0) for s, b, c in zip(occupied, base, capacity)}
    members: dict[int, list[int]] = {s: [] for s in occupied}
    for cell, s in enumerate(strata):
        members[s].append(cell)
    kept: list[int] = []
    for s in occupied:
        kept.extend(lowest(members[s], quota[s], seed))
    return sorted(kept)


def stratified(codes: list[int | None], n_categories: int, k: int, seed: int, allocation: str, minimum: int) -> list[int] | None:
    if k >= len(codes):
        return None
    strata = [c if c is not None and 0 <= c < n_categories else n_categories for c in codes]
    return split_over_strata(strata, n_categories + 1, k, seed, allocation, minimum)


def float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def spatial(coordinates: list[float | None], dimensions: int, k: int, seed: int, grid_size: int) -> list[int] | None:
    n = len(coordinates) // dimensions
    if k >= n:
        return None
    rows = [[float("nan") if v is None else float32(v) for v in coordinates[i * dimensions:(i + 1) * dimensions]] for i in range(n)]
    finite = [all(math.isfinite(v) for v in row) for row in rows]
    mins = [min((row[d] for row, f in zip(rows, finite) if f), default=math.inf) for d in range(dimensions)]
    maxs = [max((row[d] for row, f in zip(rows, finite) if f), default=-math.inf) for d in range(dimensions)]
    unplaced = grid_size ** dimensions
    boxes = []
    for row, f in zip(rows, finite):
        if not f:
            boxes.append(unplaced)
            continue
        box, scale = 0, 1
        for d in range(dimensions):
            width = maxs[d] - mins[d]
            b = 0
            if width > 0:
                b = math.floor(((row[d] - mins[d]) * grid_size) / width)
                b = min(b, grid_size - 1)
            box += b * scale
            scale *= grid_size
        boxes.append(box)
    order = sorted(set(boxes))
    dense = {box: i for i, box in enumerate(order)}
    return split_over_strata([dense[b] for b in boxes], len(order), k, seed, "balanced", 0)


def digest(n_obs: int, kept: list[int] | None) -> str:
    k = n_obs if kept is None else len(kept)
    a = (0x811C9DC5 ^ n_obs) & M32
    b = (0x9E3779B9 ^ k) & M32
    for i in range(k):
        p = i if kept is None else kept[i]
        a = ((a ^ p) * 0x01000193) & M32
        x = (b ^ p) & M32
        rotated = ((x << 13) | (x >> 19)) & M32
        b = (rotated * 5 + 0xE6546B64) & M32
    return f"{fmix32(a ^ k):08x}{fmix32(b ^ n_obs):08x}"


def encode(kept: list[int]) -> str:
    out = bytearray()
    previous = -1
    for p in kept:
        gap = p - previous - 1
        previous = p
        while gap >= 0x80:
            out.append((gap & 0x7F) | 0x80)
            gap >>= 7
        out.append(gap)
    return out.hex()


class Lcg:
    """A seeded generator of inputs (not part of the specification)."""

    def __init__(self, seed: int) -> None:
        self.state = seed & M32

    def next(self) -> int:
        self.state = (self.state * 1664525 + 1013904223) & M32
        return self.state

    def below(self, n: int) -> int:
        return self.next() % n

    def unit(self) -> float:
        return self.next() / 2**32


def build() -> dict:
    rng = Lcg(20261027)
    seeds = [0, 1, 0x9E3779B9, 0xFFFFFFFF, 12345]
    positions = [0, 1, 2, 1000, 2**31 - 1, 2**31, 2**32 - 2, 2**32 - 1]
    ranks = [{"seed": s, "positions": positions, "ranks": [rank(s, p) for p in positions]} for s in seeds]
    sizes = [1000000, 123457, 2282447, 4294967295, 3, 20]
    fractions = [
        {"fraction": f, "nObs": n, "k": count_from_fraction(f, n)}
        for f in (0.1, 0.5, 1e-9, 1.0, 0.25, 0.15, 0.3333333333333333, 0.0035, 0.0115, 0.02675, 0.3333, 0.125)
        for n in sizes
    ]
    percents = [
        {"percent": p, "nObs": n, "k": count_from_percent(p, n)}
        for p in ("0.35", "1.15", "2.675", "33.33", "0.01", "99.99", "12.5", "100", "0.0001")
        for n in sizes
    ]
    cases = []

    def add(name: str, request: dict, kept: list[int] | None, inline: bool = True) -> None:
        case = {"name": name, **request}
        if kept is None:
            case["kept"] = None
        elif inline:
            case["kept"] = kept
        else:
            case["keptCount"] = len(kept)
            case["keptHead"] = kept[:8]
            case["keptTail"] = kept[-8:]
        case["digest"] = digest(request["nObs"], kept)
        if kept is not None:
            order = priority_order(request, kept)
            if inline:
                case["order"] = order
            else:
                case["orderHead"] = order[:8]
                case["orderTail"] = order[-8:]
        cases.append(case)

    for n, k, seed in [(10, 3, 0), (100, 1, 7), (1000, 250, 42), (5000, 4999, 123), (1, 1, 0), (50, 50, 9), (50, 70, 9), (2**16 + 3, 777, 0xFFFFFFFF)]:
        add(f"uniform n={n} k={k} seed={seed}", {"method": "uniform", "nObs": n, "k": k, "seed": seed}, uniform(n, k, seed))
    add("uniform n=1000003 k=100000 seed=2024", {"method": "uniform", "nObs": 1000003, "k": 100000, "seed": 2024}, uniform(1000003, 100000, 2024), inline=False)
    for n, k, seed, size in [(1000, 250, 5, 64), (1000, 999, 1, 7), (97, 10, 3, 1), (10000, 1234, 9, 333), (10, 4, 2, 100)]:
        add(f"blocks n={n} k={k} seed={seed} blockSize={size}", {"method": "blocks", "nObs": n, "k": k, "seed": seed, "blockSize": size}, blocks(n, k, seed, size))
    for n, n_categories, used, k, allocation, minimum, seed in [
        (2000, 6, 5, 300, "proportional", 0, 11),
        (2000, 6, 5, 300, "balanced", 0, 11),
        (1500, 9, 4, 101, "balanced", 3, 4),
        (1500, 9, 4, 40, "proportional", 5, 4),
        (64, 3, 3, 10, "proportional", 0, 0),
    ]:
        weights = [1 + rng.below(20) ** 2 for _ in range(used)]
        total = sum(weights)
        codes: list[int | None] = []
        for _ in range(n):
            if rng.unit() < 0.04:
                codes.append(None)
                continue
            pick = rng.below(total)
            for c, w in enumerate(weights):
                if pick < w:
                    codes.append(c)
                    break
                pick -= w
        request = {
            "method": "stratified", "nObs": n, "k": k, "seed": seed, "allocation": allocation,
            "minPerCategory": minimum, "nCategories": n_categories, "codes": [-1 if c is None else c for c in codes],
        }
        add(f"stratified n={n} {allocation} min={minimum} k={k}", request, stratified(codes, n_categories, k, seed, allocation, minimum))
    for n, dimensions, grid, k, seed in [(1500, 2, 8, 200, 3), (500, 3, 4, 77, 8), (300, 1, 16, 31, 1), (400, 2, 1, 50, 2)]:
        values: list[float | None] = []
        for i in range(n):
            # Dense clusters and a sparse halo, a few cells without coordinates.
            cluster = rng.below(4)
            for d in range(dimensions):
                if rng.unit() < 0.01:
                    values.append(None)
                elif i % 10 == 0:
                    values.append(float32(rng.unit() * 100 - 50))
                else:
                    values.append(float32(cluster * 7 + rng.unit()))
        # The maximum is reached exactly, and a coordinate repeats it.
        values[0] = float32(1000.5)
        values[dimensions] = float32(1000.5)
        request = {"method": "spatial", "nObs": n, "k": k, "seed": seed, "gridSize": grid, "dimensions": dimensions, "coordinates": values}
        add(f"spatial {dimensions}-D n={n} grid={grid} k={k}", request, spatial(values, dimensions, k, seed, grid))
    # Coordinates a float rule must agree on: infinities, a negative zero, an
    # axis of one value, and no finite cell at all ("Infinity", "-Infinity",
    # "-0" in the file; null is NaN).
    edge_values = {
        "infinities and -0": ([float32(v) for v in (1.0, 2.0)] + [math.inf, 0.0, -0.0, 3.0, -math.inf, 4.0] * 1 + [5.0, 6.0, -0.0, -0.0, 7.5, 1.25]),
        "a constant axis": [v for i in range(10) for v in (2.5, float(i))],
        "no finite cell": [None, math.inf, -math.inf, None] * 4,
    }
    for name, values in edge_values.items():
        n = len(values) // 2
        written = [None if v is None else ("Infinity" if v == math.inf else "-Infinity" if v == -math.inf else "-0" if v == 0 and math.copysign(1, v) < 0 else v) for v in values]
        request = {"method": "spatial", "nObs": n, "k": max(1, n // 3), "seed": 5, "gridSize": 3, "dimensions": 2, "coordinates": written}
        add(f"spatial {name}", request, spatial(values, 2, max(1, n // 3), 5, 3))
    # Codes without a category written as null (NaN where codes are floats).
    null_codes: list[int | None] = [None if i % 7 == 0 else i % 3 for i in range(60)]
    add("stratified missing codes as null", {"method": "stratified", "nObs": 60, "k": 13, "seed": 2, "allocation": "balanced",
                                             "minPerCategory": 0, "nCategories": 3, "codes": null_codes},
        stratified(null_codes, 3, 13, 2, "balanced", 0))
    refusals = [
        {"name": "a minimum per category that does not fit", "method": "stratified", "nObs": 6, "k": 2, "seed": 0,
         "allocation": "proportional", "minPerCategory": 1, "nCategories": 3, "codes": [0, 1, 2, 0, 1, 2]},
    ]
    encoding = []
    for n_obs, kept in [(10, [0, 1, 2]), (1000, [5, 6, 700, 999]), (2**32 - 1, [0, 200, 2**31, 2**32 - 2])]:
        encoding.append({"nObs": n_obs, "kept": kept, "bytesHex": encode(kept), "digest": digest(n_obs, kept)})
    encoding.append({"nObs": 7, "kept": None, "bytesHex": "", "digest": digest(7, None)})
    return {
        "_about": (
            "Subsampling conformance: ranks, sizes and kept cells of the subsampling specification, "
            "computed by scripts/generate-subsample-conformance.py in plain Python, independently of the "
            "web app, Python and R implementations."
        ),
        "version": 1,
        "rank": ranks,
        "fraction": fractions,
        "percent": percents,
        "refusals": refusals,
        "cases": cases,
        "encoding": encoding,
    }


def render(document: dict) -> bytes:
    return (json.dumps(document, indent=1, sort_keys=False, allow_nan=False) + "\n").encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare instead of write")
    args = parser.parse_args()
    data = render(build())
    if args.check:
        if not TARGET.exists() or TARGET.read_bytes() != data:
            print(f"{TARGET} differs from what this script computes", file=sys.stderr)
            return 1
        print(f"{TARGET} is current")
        return 0
    TARGET.write_bytes(data)
    print(f"wrote {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
