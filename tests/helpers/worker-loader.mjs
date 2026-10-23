/**
 * The AnnData reader as the adapter meets it through the reader worker, for
 * tests that run the reader in-process: a categorical field arrives with its
 * codes narrowed to the storage the page keeps (`narrowCategoricalCodes`),
 * exactly as `anndata-reader-worker.js` answers `getObsField`. Every other
 * member is the reader's own.
 */

import { narrowCategoricalCodes } from '../../assets/js/data/categorical-storage-contract.js';

export function asWorkerLoader(reader) {
  const narrowedOf = new WeakMap();
  const originalOf = new WeakMap();
  return new Proxy(reader, {
    get(target, property) {
      if (property === 'getObsField') {
        return async (key, options) => {
          const field = await target.getObsField(key, options);
          if (field?.dtype !== 'categorical') return field;
          let narrowed = narrowedOf.get(field);
          if (narrowed === undefined) {
            const codes = narrowCategoricalCodes(field.codes, field.categories.length, `Categorical observation field '${key}'`);
            const { categories } = field;
            narrowed = {
              dtype: field.dtype,
              codes,
              categories,
              ordered: field.ordered,
              get values() {
                return Array.from(codes, code => (code < categories.length ? categories[code] : null));
              },
            };
            narrowedOf.set(field, narrowed);
            originalOf.set(narrowed, field);
          }
          return narrowed;
        };
      }
      if (property === 'releaseObsField') {
        return (key, expected) => target.releaseObsField(
          key,
          expected === undefined ? undefined : originalOf.get(expected) ?? expected
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
