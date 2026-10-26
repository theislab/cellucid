// assets/js/data/anndata/subset-entries.js
function keepSubsetEntries(rows, values, from, to, positionOf, nObs, outPositions, outValues, at) {
  let previous = -1;
  let kept = at;
  for (let entry = from; entry < to; entry++) {
    const row = rows[entry];
    if (!(row > previous && row < nObs)) return -1;
    previous = row;
    const position = positionOf[row];
    outPositions[kept] = position;
    outValues[kept] = values[entry];
    kept += ~position >>> 31;
  }
  let end = at;
  for (let entry = at; entry < kept; entry++) {
    if (outValues[entry] !== 0) {
      outPositions[end] = outPositions[entry];
      outValues[end++] = outValues[entry];
    }
  }
  return end;
}
function sortSubsetEntries(positions, values, from, to) {
  if (to - from < 2) return;
  const order = Uint32Array.from({ length: to - from }, (_, i) => from + i).sort((a, b) => positions[a] - positions[b]);
  const sortedPositions = Int32Array.from(order, (i) => positions[i]);
  const sortedValues = Float32Array.from(order, (i) => values[i]);
  positions.set(sortedPositions, from);
  values.set(sortedValues, from);
}
function keepSubsetRun({ rows, values, ranges, nObs, ascending }, positionOf) {
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
    const end = keepSubsetEntries(rows, values, from, to, positionOf, nObs, positions, kept, at);
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
//# sourceMappingURL=subset-entries.b566a5361a45.js.map
