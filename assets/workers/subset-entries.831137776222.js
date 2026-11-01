// assets/js/data/anndata/subset-entries.js
function keepSubsetEntries(rows, values, from, to, subset, nObs, outPositions, outValues, at) {
  const cellRows = subset.rows;
  const cells = cellRows.length;
  let previous = -1;
  let kept = at;
  let c = 0;
  for (let entry = from; entry < to; entry++) {
    const row = rows[entry];
    if (!(row > previous && row < nObs)) return -1;
    previous = row;
    if (c < cells && cellRows[c] < row) {
      let step = 1;
      let low = c;
      while (c + step < cells && cellRows[c + step] < row) {
        low = c + step;
        step *= 2;
      }
      let high = Math.min(cells, c + step);
      while (low < high) {
        const middle = low + high >>> 1;
        if (cellRows[middle] < row) low = middle + 1;
        else high = middle;
      }
      c = low;
    }
    if (c < cells && cellRows[c] === row) {
      const value = values[entry];
      if (value !== 0) {
        outPositions[kept] = subset.positions[c];
        outValues[kept++] = value;
      }
      c++;
    }
  }
  return kept;
}
function sortSubsetEntries(positions, values, from, to) {
  if (to - from < 2) return;
  const order = Uint32Array.from({ length: to - from }, (_, i) => from + i).sort((a, b) => positions[a] - positions[b]);
  const sortedPositions = Int32Array.from(order, (i) => positions[i]);
  const sortedValues = Float32Array.from(order, (i) => values[i]);
  positions.set(sortedPositions, from);
  values.set(sortedValues, from);
}
function keepSubsetRun({ rows, values, ranges, nObs, ascending }, subset) {
  const genes = ranges.length / 2;
  let entries = 0;
  for (let k = 0; k < genes; k++) entries += ranges[2 * k + 1] - ranges[2 * k];
  const positions = new Int32Array(entries);
  const kept = new Float32Array(entries);
  const counts = new Float64Array(genes);
  const refused = [];
  let at = 0;
  for (let k = 0; k < genes; k++) {
    const from = ranges[2 * k];
    const to = ranges[2 * k + 1];
    const end = keepSubsetEntries(rows, values, from, to, subset, nObs, positions, kept, at);
    if (end < 0) {
      refused.push({ gene: k, rows: rows.slice(from, to), values: values.slice(from, to) });
      continue;
    }
    if (!ascending) sortSubsetEntries(positions, kept, at, end);
    counts[k] = end - at;
    at = end;
  }
  return { positions: positions.slice(0, at), values: kept.slice(0, at), counts, refused };
}
export {
  keepSubsetEntries,
  keepSubsetRun,
  sortSubsetEntries
};
//# sourceMappingURL=subset-entries.831137776222.js.map
