"""Create the analysis parity fixtures.

``tests/fixtures/analysis/scanpy-reference.json`` holds a small synthetic
AnnData and what scanpy, SciPy and numpy compute from it; the analysis
contract tests compute the same in the browser's code and compare
(``tests/analysis-scanpy-rank-genes-parity.test.mjs``,
``analysis-score-genes-parity``, ``analysis-ucell-parity``, and the
composition and dot plot tests). ``scanpy-reference.json.sha256`` is its
SHA-256, so a fixture edited by hand is caught.

Run it isolated, with the pinned versions below installed (never into a
repository environment)::

    python -I scripts/generate-analysis-fixtures.py

The data (``synthetic_adata``): 600 cells x 48 genes. ``obs``:

- ``group``: six groups ``g0``..``g5`` of 200, 160, 130, 97, 4 and 9 cells
  (a group under the default minimum of 10 cells, and one far under it);
- ``sample``: twelve samples ``s00``..``s11``, every cell in one;
- ``condition``: ``ctrl`` for ``s00``..``s05``, ``stim`` for ``s06``..``s11``
  (samples are nested in conditions).

``X`` is zero-inflated with heavy ties: every value is a multiple of 1/4 up to
4 (dyadic, so float32 holds it exactly and every sum of a few hundred of them
is exact). ``layers['scaled']`` is ``X - 1`` (negative values).
``var_names`` include ``MT-CO1``, ``RPL3`` and ``HBB`` for the gene-family
filters.

Each reference block is computed by one function of ``adata``; ``main()``
merges them into the JSON. The composition and dot plot block is
``composition_and_dotplot_references`` at the end of the file.
"""

from __future__ import annotations

import hashlib
import json
import sys
import warnings
from importlib.metadata import version
from pathlib import Path

PINNED = {
    'scanpy': '1.11.4',
    'anndata': '0.12.2',
    'numpy': '2.2.6',
    'scipy': '1.15.3',
    'statsmodels': '0.14.6',
    'pandas': '2.3.1',
}

for package, pinned in PINNED.items():
    installed = version(package)
    if installed != pinned:
        sys.exit(f'{package} {installed} is installed; the fixtures are made with {pinned}')

warnings.filterwarnings('ignore', category=FutureWarning)

import anndata as ad  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import scanpy as sc  # noqa: E402
from scipy import stats  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'fixtures' / 'analysis' / 'scanpy-reference.json'

GROUP_SIZES = {'g0': 200, 'g1': 160, 'g2': 130, 'g3': 97, 'g4': 4, 'g5': 9}
SAMPLES = [f's{i:02d}' for i in range(12)]


def synthetic_adata() -> ad.AnnData:
    """The shared synthetic AnnData (module docstring)."""
    rng = np.random.default_rng(20261023)
    groups = np.concatenate([[name] * size for name, size in GROUP_SIZES.items()])
    n_cells = groups.size
    names = [f'Gene{i:02d}' for i in range(45)] + ['MT-CO1', 'RPL3', 'HBB']
    n_genes = len(names)
    # Per group and gene: a dropout rate and a level, so groups differ.
    X = np.zeros((n_cells, n_genes), dtype=np.float32)
    offset = 0
    for g, size in enumerate(GROUP_SIZES.values()):
        dropout = rng.uniform(0.3, 0.9, size=n_genes)
        level = rng.integers(1, 12, size=n_genes)
        for j in range(n_genes):
            expressed = rng.random(size) > dropout[j]
            quarters = np.clip(rng.poisson(level[j], size=size), 0, 16)
            X[offset:offset + size, j] = np.where(expressed, quarters / 4.0, 0.0)
        offset += size
    order = rng.permutation(n_cells)
    X = X[order]
    groups = groups[order]
    sample = rng.choice(SAMPLES, size=n_cells)
    condition = np.where(np.isin(sample, SAMPLES[:6]), 'ctrl', 'stim')
    obs = pd.DataFrame({
        'group': pd.Categorical(groups, categories=list(GROUP_SIZES)),
        'sample': pd.Categorical(sample, categories=SAMPLES),
        'condition': pd.Categorical(condition, categories=['ctrl', 'stim']),
    }, index=[f'cell{i:03d}' for i in range(n_cells)])
    adata = ad.AnnData(X=X, obs=obs, var=pd.DataFrame(index=names))
    adata.layers['scaled'] = X - np.float32(1.0)
    adata.uns['log1p'] = {'base': None}
    return adata


def _floats(values) -> list:
    return [None if not np.isfinite(v) else float(v) for v in np.asarray(values, dtype=np.float64)]


def _rank_genes(adata, layer=None, **kwargs) -> dict:
    """``rank_genes_groups`` over every gene, per group, as scanpy ranks them."""
    work = adata.copy()
    sc.tl.rank_genes_groups(work, 'group', layer=layer, use_raw=False, pts=True,
                            n_genes=work.n_vars, key_added='rgg', **kwargs)
    out = {}
    groups = list(work.uns['rgg']['names'].dtype.names)
    for group in groups:
        frame = sc.get.rank_genes_groups_df(work, group=group, key='rgg')
        out[group] = {
            'names': frame['names'].astype(str).tolist(),
            'scores': _floats(frame['scores']),
            'logfoldchanges': _floats(frame['logfoldchanges']),
            'pvals': _floats(frame['pvals']),
            'pvals_adj': _floats(frame['pvals_adj']),
            'pct_nz_group': _floats(frame['pct_nz_group']),
            # scanpy keeps the reference's fraction only against the rest.
            'pct_nz_reference': _floats(frame['pct_nz_reference']) if 'pct_nz_reference' in frame else None,
        }
    return out


def rank_genes_references(adata) -> dict:
    """scanpy ``rank_genes_groups``: each method and convention the options offer."""
    cases = {
        'wilcoxon': dict(method='wilcoxon', tie_correct=False),
        'wilcoxon_tie': dict(method='wilcoxon', tie_correct=True),
        'ttest': dict(method='t-test'),
        'ttest_overestim_var': dict(method='t-test_overestim_var'),
        'wilcoxon_reference_g2': dict(method='wilcoxon', reference='g2'),
        'ttest_reference_g2': dict(method='t-test', reference='g2'),
        'wilcoxon_groups_subset': dict(method='wilcoxon', groups=['g0', 'g1', 'g3']),
        'wilcoxon_bonferroni': dict(method='wilcoxon', corr_method='bonferroni'),
        'wilcoxon_scaled': dict(method='wilcoxon', layer='scaled'),
    }
    out = {}
    for name, kwargs in cases.items():
        layer = kwargs.pop('layer', None)
        out[name] = {'options': {**kwargs, 'layer': layer}, 'groups': _rank_genes(adata, layer=layer, **kwargs)}
    return out


def mannwhitney_references(adata) -> dict:
    """SciPy ``mannwhitneyu`` two-sided, as Cellucid's default convention
    applies it: exact when both sides are under 50 cells and untied, else
    the normal approximation with tie and continuity correction."""
    X = np.asarray(adata.X, dtype=np.float64)
    groups = adata.obs['group'].to_numpy()
    out = []
    pairs = [('g0', 'g1'), ('g4', 'g5'), ('g3', 'g5')]
    for a, b in pairs:
        for j in range(0, adata.n_vars, 7):
            x = X[groups == a, j]
            y = X[groups == b, j]
            pooled = np.concatenate([x, y])
            tied = np.unique(pooled).size < pooled.size
            method = 'exact' if (x.size < 50 and y.size < 50 and not tied) else 'asymptotic'
            result = stats.mannwhitneyu(x, y, alternative='two-sided', method=method, use_continuity=True)
            out.append({'a': a, 'b': b, 'gene': adata.var_names[j], 'method': method,
                        'U': float(result.statistic), 'p': float(result.pvalue)})
    # Untied small samples: the exact distribution.
    rng = np.random.default_rng(7)
    for n1, n2 in [(4, 9), (12, 15), (30, 41)]:
        x = rng.normal(size=n1)
        y = rng.normal(0.4, size=n2)
        result = stats.mannwhitneyu(x, y, alternative='two-sided', method='exact')
        out.append({'x': _floats(x), 'y': _floats(y), 'method': 'exact',
                    'U': float(result.statistic), 'p': float(result.pvalue)})
    return out


SIGNATURE_GENES = ['Gene01', 'Gene05', 'Gene10', 'Gene22', 'MT-CO1']


def score_genes_references(adata) -> dict:
    """scanpy ``score_genes`` with ``ctrl_size`` at least every bin's
    population, so the control set is every non-signature gene of the
    signature genes' bins whatever generator draws them."""
    out = {}
    for bins in (25, 5):
        work = adata.copy()
        sc.tl.score_genes(work, SIGNATURE_GENES, ctrl_size=work.n_vars, n_bins=bins,
                          random_state=0, use_raw=False, score_name='score')
        out[f'bins_{bins}'] = {
            'genes': SIGNATURE_GENES,
            'ctrl_size': int(work.n_vars),
            'n_bins': bins,
            'scores': _floats(work.obs['score']),
        }
    return out


def ucell_references(adata) -> dict:
    """UCell scores in numpy: each cell's genes ranked by value, highest
    first, ties averaged (``rankdata``); ranks above ``max_rank`` count as
    ``max_rank + 1``; score ``1 - (sum(ranks) - S(S+1)/2) / (S * max_rank)``."""
    X = np.asarray(adata.X, dtype=np.float64)
    columns = [list(adata.var_names).index(g) for g in SIGNATURE_GENES]
    s = len(columns)
    out = {}
    for max_rank in (10, 30, adata.n_vars):
        ranks = np.apply_along_axis(lambda row: stats.rankdata(-row, method='average'), 1, X)
        picked = ranks[:, columns]
        picked = np.where(picked > max_rank, max_rank + 1, picked)
        u = picked.sum(axis=1) - s * (s + 1) / 2
        out[f'max_rank_{max_rank}'] = {'genes': SIGNATURE_GENES, 'max_rank': int(max_rank),
                                       'scores': _floats(1 - u / (s * max_rank))}
    return out


def data_record(adata) -> dict:
    """The AnnData itself, as the tests rebuild it."""
    return {
        'var_names': list(map(str, adata.var_names)),
        'obs': {key: adata.obs[key].astype(str).tolist() for key in adata.obs.columns},
        'X': [_floats(row) for row in np.asarray(adata.X)],
        'uns': {'log1p': {'base': None}},
    }


def main() -> None:
    adata = synthetic_adata()
    reference = {
        'versions': PINNED,
        'data': data_record(adata),
        'rank_genes_groups': rank_genes_references(adata),
        'mannwhitneyu': mannwhitney_references(adata),
        'score_genes': score_genes_references(adata),
        'ucell': ucell_references(adata),
    }
    # The composition and dot plot block (its own function, below).
    reference.update(composition_and_dotplot_references(adata.copy()))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(reference, indent=1, sort_keys=True) + '\n'
    OUT.write_text(text)
    digest = hashlib.sha256(text.encode()).hexdigest()
    OUT.with_name(OUT.name + '.sha256').write_text(f'{digest}  {OUT.name}\n')
    print(f'wrote {OUT.relative_to(ROOT)} ({len(text):,} bytes, sha256 {digest[:12]})')


# --- composition and dot plot ---


DOTPLOT_GENES = ['Gene00', 'Gene01', 'Gene02', 'Gene03', 'Gene10', 'Gene11', 'Gene12', 'MT-CO1']
DOTPLOT_SETS = [{'name': 'Set A', 'start': 0, 'end': 4}, {'name': 'Set B', 'start': 4, 'end': 8}]


def composition_and_dotplot_references(adata) -> dict:
    """The composition and dot plot references: returns the keys
    ``composition`` and ``dotplot``.

    Composition (``tests/analysis-composition-stats.test.mjs``): for each
    case, a condition per cell and whether samples are used; the expected
    cell counts per type and unit (units in sample, then condition order;
    a sample in two conditions is two units), and per type SciPy on the
    per-unit values: Welch's t (``ttest_ind(equal_var=False)``) or one-way
    ANOVA (``f_oneway``) on logit proportions ``(count + 0.5) / (total + 1)``
    and on CLR (pseudocount 0.5); Wilcoxon (``mannwhitneyu``: exact when both
    sides are under 50 and untied, else asymptotic with continuity
    correction, as R) or ``kruskal`` on proportions; BH
    (``false_discovery_control``) and Bonferroni. Without samples, one unit
    per condition: ``chi2_contingency`` of type x condition, and per type of
    that type against the rest (Yates on 2 x 2; ``fisher_exact`` for a 2 x 2
    table with an expected count below 5).

    Dot plot (``tests/analysis-dotplot-summary.test.mjs``): scanpy
    ``pl.dotplot(..., return_fig=True)`` ``dot_color_df`` and
    ``dot_size_df`` for ``DOTPLOT_GENES`` by ``group``: plain,
    ``standard_scale='var'``, ``mean_only_expressed=True``,
    ``expression_cutoff=1.5`` and on ``layers['scaled']`` (negative values).
    """
    obs = adata.obs
    types = list(obs['group'].cat.categories)
    samples = list(obs['sample'].cat.categories)
    sample_code = obs['sample'].cat.codes.to_numpy()
    type_code = obs['group'].cat.codes.to_numpy()

    # Conditions: the nested two; three, by sample; and two with one sample
    # (s05) split across both.
    three = np.select([sample_code < 4, sample_code < 8], ['ctrl', 'stim'], 'tx')
    split = obs['condition'].astype(str).to_numpy().copy()
    rng = np.random.default_rng(7)
    moved = (sample_code == 5) & (rng.random(adata.n_obs) < 0.5)
    split[moved] = 'stim'
    variants = {
        'nested': (obs['condition'].astype(str).to_numpy(), ['ctrl', 'stim']),
        'three': (three, ['ctrl', 'stim', 'tx']),
        'split': (split, ['ctrl', 'stim']),
    }

    def table(condition, names, with_samples):
        index = {name: i for i, name in enumerate(names)}
        cond = np.array([index[c] for c in condition])
        unit_key = (sample_code if with_samples else np.zeros_like(sample_code)) * len(names) + cond
        keys = np.unique(unit_key)
        column = {key: i for i, key in enumerate(keys)}
        counts = np.zeros((len(types), len(keys)), dtype=np.int64)
        for t, key in zip(type_code, unit_key):
            counts[t, column[key]] += 1
        return counts, (keys % len(names)).astype(int), (keys // len(names)).astype(int)

    def transformed(counts, method):
        totals = counts.sum(axis=0)
        if method == 'logit':
            p = (counts + 0.5) / (totals + 1)
            return np.log(p / (1 - p))
        if method == 'clr':
            logs = np.log(counts + 0.5)
            return logs - logs.mean(axis=0)
        return counts / totals

    def per_type(values, unit_condition, k, method):
        out = []
        for row in values:
            groups = [row[unit_condition == c] for c in range(k)]
            if method == 'rank' and k == 2:
                pooled = np.concatenate(groups)
                exact = np.unique(pooled).size == pooled.size and all(len(g) < 50 for g in groups)
                r = stats.mannwhitneyu(groups[0], groups[1], alternative='two-sided',
                                       method='exact' if exact else 'asymptotic', use_continuity=True)
            elif method == 'rank':
                r = stats.kruskal(*groups)
            elif k == 2:
                r = stats.ttest_ind(groups[0], groups[1], equal_var=False)
            else:
                r = stats.f_oneway(*groups)
            out.append((float(r.statistic), float(r.pvalue)))
        return out

    cases = []
    for name, (condition, names) in variants.items():
        counts, unit_condition, unit_sample = table(condition, names, True)
        k = len(names)
        tests = {}
        for method in ('logit', 'clr', 'rank'):
            rows = per_type(transformed(counts, method), unit_condition, k, method)
            p = np.array([row[1] for row in rows])
            tests[method] = {
                'statistic': _floats([row[0] for row in rows]),
                'pvalue': _floats(p),
                'bh': _floats(stats.false_discovery_control(p, method='bh')),
                'bonferroni': _floats(np.minimum(1, p * p.size)),
            }
        cases.append({
            'name': name, 'samples': True, 'condition': list(map(str, condition)),
            'conditionNames': names, 'counts': counts.tolist(),
            'unitCondition': unit_condition.tolist(), 'unitSample': unit_sample.tolist(),
            'tests': tests,
        })
        if name == 'split':
            continue
        counts, unit_condition, _ = table(condition, names, False)
        overall = stats.chi2_contingency(counts)
        per = []
        for t in range(len(types)):
            pair = np.vstack([counts[t], counts.sum(axis=0) - counts[t]])
            chi = stats.chi2_contingency(pair)
            if pair.shape == (2, 2) and chi.expected_freq.min() < 5:
                fisher = stats.fisher_exact(pair)
                per.append({'test': 'fisher', 'statistic': float(fisher.statistic), 'pvalue': float(fisher.pvalue)})
            else:
                per.append({'test': 'chi2', 'statistic': float(chi.statistic), 'pvalue': float(chi.pvalue)})
        cases.append({
            'name': f'{name}-cells', 'samples': False, 'condition': list(map(str, condition)),
            'conditionNames': names, 'counts': counts.tolist(), 'unitCondition': unit_condition.tolist(),
            'overall': {'statistic': float(overall.statistic), 'df': int(overall.dof), 'pvalue': float(overall.pvalue)},
            'perType': per,
        })

    dot_cases = {}
    for name, kwargs in {
        'plain': {},
        'var': {'standard_scale': 'var'},
        'expressing': {'mean_only_expressed': True},
        'cutoff': {'expression_cutoff': 1.5},
        'scaled': {'layer': 'scaled'},
    }.items():
        fig = sc.pl.dotplot(adata, DOTPLOT_GENES, groupby='group', return_fig=True, **kwargs)
        dot_cases[name] = {
            'color': [_floats(row) for row in fig.dot_color_df.loc[types, DOTPLOT_GENES].to_numpy()],
            'size': [_floats(row) for row in fig.dot_size_df.loc[types, DOTPLOT_GENES].to_numpy()],
        }
    return {
        'composition': {'types': types, 'samples': samples, 'cases': cases},
        'dotplot': {'groups': types, 'genes': DOTPLOT_GENES, 'geneSets': DOTPLOT_SETS, 'cases': dot_cases},
    }


if __name__ == '__main__':
    main()
