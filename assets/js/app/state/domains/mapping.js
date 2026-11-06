/**
 * @fileoverview The `mapping` state domain: which stored arrays the open
 * dataset is plotted and read with (Session › Data mapping).
 *
 * Value: the canonical DataMapping (`data/data-mapping.js`) the dataset is
 * shown with, as `getDataMapping()` gives it, or null while no dataset is
 * open. Restored first after the open cells (`app/actions/domains.js`): the
 * embeddings, gene list and graph it names are what every other value is
 * read against.
 *
 * Restore applies it through `applyDataMapping` (origin `session`: a state
 * put back, as a session file's), which moves the views that follow their
 * dimension's default with it; the `views` domain, restored next, puts each
 * view's own representation back.
 *
 * The open cells are not part of this value: which cells are open is the
 * reading of the dataset (Session › Open data), and every per-cell part of a
 * value is named by original position (`cell-positions.js`), so it applies to the
 * cells that are open.
 *
 * @module app/state/domains/mapping
 */

import { MAPPING_GROUP_LABELS, describeMappingGroupValue } from '../../../data/dataset-mapping.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * @param {{state: object, refreshUi: () => void}} options
 */
export function createMappingDomain({ state, refreshUi }) {
  return {
    capture() {
      const mapping = state.getDataMapping();
      return mapping === null ? null : structuredClone(mapping);
    },
    async restore(value) {
      const current = state.getDataMapping();
      if (JSON.stringify(current) === JSON.stringify(value)) return;
      if (value === null || current === null) {
        throw new RangeError(value === null
          ? 'The data mapping to restore belongs to no dataset, and a dataset is open.'
          : 'A data mapping cannot be restored while no dataset is open.');
      }
      await state.applyDataMapping(value, { origin: 'session' });
      refreshUi();
    },
    describe(a, b) {
      if (a === null || b === null) return [b === null ? 'No dataset' : 'Dataset opened'];
      const lines = [];
      if (JSON.stringify(a.embeddings) !== JSON.stringify(b.embeddings)) {
        const before = new Set(a.embeddings?.enabled?.map(ref => JSON.stringify(ref)) ?? []);
        const after = new Set(b.embeddings?.enabled?.map(ref => JSON.stringify(ref)) ?? []);
        const added = [...after].filter(ref => !before.has(ref)).length;
        const removed = [...before].filter(ref => !after.has(ref)).length;
        lines.push(added + removed === 0
          ? 'Data mapping: default embeddings changed'
          : `Data mapping: ${formatCountOf(added, 'embedding')} on, ${removed} off`);
      }
      for (const [group, label] of Object.entries(MAPPING_GROUP_LABELS)) {
        if (JSON.stringify(a[group]) === JSON.stringify(b[group])) continue;
        lines.push(`Data mapping: ${label} ${describeMappingGroupValue(group, b[group])}`);
      }
      return lines;
    },
  };
}
