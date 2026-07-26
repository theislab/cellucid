/**
 * Build the exact deterministic GPU encoding for scientific connectivity
 * weights. The canonical Float64Array remains untouched; rendering receives
 * one relative-strength Float32Array because WebGL2 shader storage is
 * single-precision.
 *
 * @param {Float64Array} weights
 * @returns {{values: Float32Array, maxWeight: number}}
 */
export function createConnectivityRenderWeights(weights) {
  if (!(weights instanceof Float64Array)) {
    throw new TypeError(
      'Connectivity rendering requires canonical Float64 weights.'
    );
  }
  if (weights.length === 0) {
    return Object.freeze({
      values: new Float32Array(0),
      maxWeight: 0,
    });
  }

  let maxWeight = 0;
  for (let index = 0; index < weights.length; index++) {
    const weight = weights[index];
    if (!Number.isFinite(weight) || !(weight > 0)) {
      throw new Error(
        `Connectivity weight ${index} must be finite and strictly positive.`
      );
    }
    if (weight > maxWeight) maxWeight = weight;
  }

  const values = new Float32Array(weights.length);
  for (let index = 0; index < weights.length; index++) {
    const relativeWeight = Math.fround(weights[index] / maxWeight);
    if (!Number.isFinite(relativeWeight) || !(relativeWeight > 0)) {
      throw new Error(
        'Connectivity weight range exceeds WebGL2 Float32 rendering precision.'
      );
    }
    values[index] = relativeWeight;
  }

  return Object.freeze({ values, maxWeight });
}
