/**
 * @fileoverview The provenance record embedded into every exported figure.
 *
 * WHY THIS IS SHARED:
 * A figure's provenance is a scientific claim: it tells a reader which view,
 * which colour field, and which filters produced what they are looking at. A
 * multi-panel figure makes that claim once for the whole file, so the record
 * must describe *every* panel. Describing only the active view attributes one
 * panel's field and filters to all of them — a false statement in a published
 * figure.
 *
 * SVG (RDF/Dublin Core) and PNG (iTXt) previously built that text twice, which
 * is how the two could drift. One builder now serves both, so the description
 * a reader finds in an SVG is byte-identical to the one in the PNG of the same
 * export.
 *
 * @module ui/modules/figure-export/utils/figure-provenance
 */

import { panelLetter } from './panel-label.js';

/**
 * @typedef {object} ProvenanceView
 * @property {string} id
 * @property {string} label
 * @property {string|null} fieldKey
 * @property {string|null} fieldKind
 * @property {string[]} filters
 */

/**
 * The placeholder DataState publishes when a view has no active filter. It is
 * a UI sentence, not a filter, so it never enters the provenance record.
 */
const NO_FILTER_PLACEHOLDER = /No filters active/i;

/**
 * Filter lines that actually describe a restriction.
 *
 * @param {unknown} filters
 * @returns {string[]}
 */
export function meaningfulFilterLines(filters) {
  if (!Array.isArray(filters)) return [];
  return filters
    .filter((line) => typeof line === 'string' && line.length > 0)
    .filter((line) => !NO_FILTER_PLACEHOLDER.test(line));
}

/**
 * Read the exact per-view provenance records out of an export payload's meta.
 *
 * @param {any} meta
 * @returns {ProvenanceView[]}
 */
export function readProvenanceViews(meta) {
  const views = meta?.views;
  if (!Array.isArray(views) || views.length === 0) {
    throw new TypeError(
      'Figure export metadata must publish one provenance record per exported view.'
    );
  }
  return views.map((view, index) => {
    const context = `Figure export provenance view ${index}`;
    if (
      view === null ||
      typeof view !== 'object' ||
      typeof view.id !== 'string' ||
      view.id.length === 0 ||
      typeof view.label !== 'string' ||
      view.label.length === 0 ||
      (view.fieldKey !== null && typeof view.fieldKey !== 'string') ||
      (view.fieldKind !== null && typeof view.fieldKind !== 'string') ||
      !Array.isArray(view.filters) ||
      view.filters.some((line) => typeof line !== 'string')
    ) {
      throw new TypeError(`${context} is incomplete.`);
    }
    return {
      id: view.id,
      label: view.label,
      fieldKey: view.fieldKey,
      fieldKind: view.fieldKind,
      filters: [...view.filters],
    };
  });
}

/**
 * The colour field of the figure as a whole, or null when the panels disagree.
 *
 * A single key is only claimed when every panel really carries it; otherwise
 * the per-panel record in the JSON blob is the only truthful answer.
 *
 * @param {ProvenanceView[]} views
 * @returns {string|null}
 */
export function unanimousFieldKey(views) {
  const first = views[0]?.fieldKey ?? null;
  if (first === null) return null;
  return views.every((view) => view.fieldKey === first) ? first : null;
}

/**
 * The source path or URL the dataset was loaded from, when known.
 *
 * @param {any} meta
 * @returns {string|null}
 */
export function readProvenanceSourceFile(meta) {
  return (
    meta?.datasetUserPath ||
    meta?.datasetSourceUrl ||
    meta?.datasetBaseUrl ||
    null
  );
}

/**
 * Human-readable provenance summary embedded as the SVG `dc:description` and
 * the PNG `Description` chunk.
 *
 * Every panel appears with the letter it is drawn with, its colour field, and
 * its own filters, so no panel's state can be read as another panel's.
 *
 * @param {any} meta
 * @returns {string}
 */
export function buildProvenanceDescription(meta) {
  const views = readProvenanceViews(meta);
  const multiPanel = views.length > 1;
  const clauses = views.map((view, index) => {
    const name = multiPanel
      ? `${panelLetter(index)}. ${view.label}`
      : view.label;
    const filters = meaningfulFilterLines(view.filters);
    const field = view.fieldKey === null ? 'none' : view.fieldKey;
    const filterText = filters.length === 0 ? 'none' : filters.join('; ');
    return `${name} (Field: ${field}; Filters: ${filterText})`;
  });

  const parts = [`Views: ${clauses.join(' | ')}`];
  const sourceFile = readProvenanceSourceFile(meta);
  if (sourceFile) parts.push(`Source: ${sourceFile}`);
  return parts.join(' • ');
}

/**
 * Structured provenance blob embedded as the SVG `cellucid:json` element and
 * the PNG `Comment` chunk.
 *
 * @param {any} meta
 * @param {any} payload
 * @param {'png'|'svg'} format
 * @returns {string} Compact JSON
 */
export function buildProvenanceJson(meta, payload, format) {
  const website = 'https://cellucid.com';
  const views = readProvenanceViews(meta);
  const multiPanel = views.length > 1;

  return JSON.stringify(
    {
      generator: website,
      exporter: meta?.exporter || { name: 'Cellucid', website },
      exportedAt: String(meta?.exportedAt || ''),
      dataset: {
        name: meta?.datasetName || null,
        id: meta?.datasetId || null,
        sourceType: meta?.sourceType || null,
        baseUrl: meta?.datasetBaseUrl || null,
        userPath: meta?.datasetUserPath || null,
        source: {
          name: meta?.datasetSourceName || null,
          url: meta?.datasetSourceUrl || null,
          citation: meta?.datasetSourceCitation || null,
        },
      },
      views: views.map((view, index) => ({
        panel: multiPanel ? panelLetter(index) : null,
        id: view.id,
        label: view.label,
        field: {
          key: view.fieldKey,
          kind: view.fieldKind,
        },
        filters: meaningfulFilterLines(view.filters),
      })),
      export: {
        format,
        width: Number.isFinite(payload?.width) ? payload.width : null,
        height: Number.isFinite(payload?.height) ? payload.height : null,
        dpi: Number.isFinite(payload?.dpi) ? payload.dpi : null,
        strategy: payload.options.strategy,
        includeAxes: payload.options.includeAxes,
        includeLegend: payload.options.includeLegend,
        legendPosition: payload.options.legendPosition,
        background: payload.options.background,
        backgroundColor: payload.options.backgroundColor,
        crop: payload.options.crop,
      },
    },
    null,
    0
  );
}
