/**
 * Every (i) tip in the interface is complete and points at documentation that
 * exists.
 *
 * - every tip the markup or a component names is in the registry
 *   (assets/js/app/ui/components/info-tips.js), and every registry entry is
 *   used;
 * - every static tip takes its words from the registry, never inline copy;
 * - every entry has a title, a body and at least one docs link whose text
 *   names its target (never a bare URL);
 * - the link list is pinned, so a changed target is a reviewed change;
 * - when the documentation tree is present (the sibling cellucid-python
 *   checkout, or CELLUCID_PYTHON_DOCS), every link resolves to a page that
 *   exists and to a heading anchor on it, computed the way Sphinx computes
 *   section ids.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOCS_BASE_URL,
  INFO_TIPS,
  docsUrl,
} from '../assets/js/app/ui/components/info-tips.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const indexHtml = await readFile(path.join(ROOT, 'index.html'), 'utf8');

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(relative));
    else if (entry.name.endsWith('.js')) out.push(relative);
  }
  return out;
}

const componentSources = await Promise.all(
  jsFiles('assets/js/app').map(async file => [file, await readFile(path.join(ROOT, file), 'utf8')]),
);

const staticKeys = [...indexHtml.matchAll(/data-info-tip="([^"]+)"/g)].map(match => match[1]);
// A component names a tip through `createInfoTip({ tip: '…' })`, a `tip: '…'`
// option of a control builder (field, select field, disclosure), a template's
// `data-info-tip="…"`, or the community panel's `createInfoTooltip(label, key)`.
const componentKeys = componentSources.flatMap(([, source]) => [
  ...[...source.matchAll(/\btip:\s*'([a-z][a-z0-9-]*)'/g)].map(match => match[1]),
  ...[...source.matchAll(/data-info-tip="([a-z][a-z0-9-]*)"/g)].map(match => match[1]),
  ...[...source.matchAll(/createInfoTooltip\('[^']+',\s*'([^']+)'\)/g)].map(match => match[1]),
  // A key handed through a helper's positional argument (the community
  // panel's peer disclosures) is still a named use of the registry.
  ...Object.keys(INFO_TIPS).filter(key => (
    new RegExp(`createPeerDisclosure\\([^)]*'${key}'`).test(source)
  )),
]);

test('every tip the interface names is in the registry, and every entry is used', () => {
  const used = new Set([...staticKeys, ...componentKeys]);
  assert.ok(staticKeys.length >= 35, `the sidebar names its tips (${staticKeys.length})`);
  assert.ok(componentKeys.length >= 8, `components name their tips (${componentKeys.length})`);
  for (const key of used) assert.ok(Object.hasOwn(INFO_TIPS, key), `unknown tip "${key}"`);
  for (const key of Object.keys(INFO_TIPS)) assert.ok(used.has(key), `tip "${key}" is never shown`);
});

test('every static info button opens a registry tip, with no inline copy', () => {
  const buttons = [...indexHtml.matchAll(/<button\b[^>]*class="info-btn"[^>]*>/g)].map(match => match[0]);
  assert.ok(buttons.length >= 35);
  for (const button of buttons) {
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1];
    assert.ok(controls, `${button} names its popover`);
    const popover = new RegExp(`<div id="${controls}" class="info-tooltip"[^>]*data-info-tip="[^"]+"[^>]*hidden></div>`).exec(indexHtml);
    assert.ok(popover, `#${controls} is an empty popover that names its registry tip`);
  }
  assert.doesNotMatch(indexHtml, /info-tooltip-content|info-step/, 'tip text lives in the registry only');
});

test('every tip has a title, a body and docs links named by their target', () => {
  for (const [key, tip] of Object.entries(INFO_TIPS)) {
    assert.ok(tip.title.trim().length > 0, `${key}: title`);
    assert.ok(tip.body.length > 0, `${key}: body`);
    const text = tip.body.flatMap(block => (typeof block === 'string' ? [block] : block.list)).join(' ');
    assert.ok(text.length >= 80, `${key}: the tip says enough to be useful (${text.length} chars)`);
    assert.doesNotMatch(text, /https?:\/\//, `${key}: no raw URL in the text`);
    assert.equal(text.split('`').length % 2, 1, `${key}: code spans are balanced`);
    assert.ok(tip.links.length >= 1, `${key}: at least one docs link`);
    for (const link of tip.links) {
      assert.ok(link.label.length >= 3 && link.label.length <= 40, `${key}: link text "${link.label}"`);
      assert.doesNotMatch(link.label, /https?:|docs\.cellucid|\.html/, `${key}: link text names the page, not the URL`);
      assert.match(link.page, /^[a-z]_[a-z0-9_]+\/[a-z0-9_]+$/, `${key}: page path ${link.page}`);
      assert.match(link.anchor, /^[a-z][a-z0-9-]*$/, `${key}: anchor ${link.anchor}`);
      assert.ok(docsUrl(link).startsWith(DOCS_BASE_URL));
    }
  }
});

/** Every distinct link the tips use, pinned. */
const PINNED_LINKS = [
  'b_data_loading/13_data_mapping#neighbour-graph',
  'b_data_loading/13_data_mapping#genes-and-expression',
  'b_data_loading/13_data_mapping#latent-space',
  'b_data_loading/13_data_mapping#vector-fields',
  'f_highlighting_selection/02_selection_tools_document_each_tool#tool-4-knn-drag-alt-click-drag-degree',
  'a_orientation/03_quick_tour_60_seconds#fast-path-click-by-click',
  'b_data_loading/01_loading_options_overview#at-a-glance',
  'b_data_loading/01_loading_options_overview#fast-path-choose-a-workflow-decision-tree',
  'b_data_loading/02_local_demo_tutorial#step-4-publish-to-a-public-github-repo-remote-demo',
  'b_data_loading/03_browser_file_picker_tutorial#fast-path-wet-lab-friendly',
  'b_data_loading/04_server_tutorial#connectivity-is-opt-in-on-this-path',
  'b_data_loading/04_server_tutorial#fast-path-cli',
  'b_data_loading/04_server_tutorial#remote-server-access-ssh-tunnel-workflow',
  'b_data_loading/06_dataset_identity_why_it_matters#the-one-sentence-definition',
  'b_data_loading/07_folder_file_format_expectations_high_level_link_to_spec#the-four-things-cellucid-can-load-practical-view',
  'b_data_loading/11_custom_dataset_repository#the-repository-contract',
  'b_data_loading/13_data_mapping#at-a-glance',
  'b_data_loading/13_data_mapping#choose-the-embeddings-views-can-show',
  'b_data_loading/13_data_mapping#dimension-and-columns-of-an-array',
  'b_data_loading/13_data_mapping#files-without-a-umap-the-best-guess',
  'b_data_loading/13_data_mapping#several-embeddings-at-once',
  'b_data_loading/13_data_mapping#what-stays-fixed',
  'c_core_interactions/01_navigation_modes_orbit_planar_free_fly#each-view-navigates-on-its-own',
  'c_core_interactions/01_navigation_modes_orbit_planar_free_fly#pick-the-right-mode-fast-guidance',
  'c_core_interactions/02_camera_controls_advanced#camera-path-playback-is-opt-in',
  'c_core_interactions/02_camera_controls_advanced#free-fly-controls',
  'c_core_interactions/02_camera_controls_advanced#keyboard-shortcuts-that-affect-camera-navigation',
  'd_fields_coloring_legends/08_cell_info#cost-on-large-datasets',
  'b_data_loading/12_sample_dataset_provenance#what-to-do-with-this',
  'l_sessions_sharing/13_share_links_badges_and_embeds#which-datasets-can-be-shared',
  'l_sessions_sharing/13_share_links_badges_and_embeds#open-in-cellucid-badge',
  'l_sessions_sharing/13_share_links_badges_and_embeds#embed-in-a-web-page',
  'd_fields_coloring_legends/08_cell_info#what-the-card-shows',
  'c_core_interactions/03_render_modes_points_vs_volumetric_smoke#choose-the-representation-before-tuning-it',
  'c_core_interactions/03_render_modes_points_vs_volumetric_smoke#points-mode',
  'c_core_interactions/03_render_modes_points_vs_volumetric_smoke#smoke-controls-exact-current-inventory',
  'c_core_interactions/03_render_modes_points_vs_volumetric_smoke#what-is-rebuilt-and-when',
  'c_core_interactions/03_render_modes_points_vs_volumetric_smoke#what-the-smoke-cloud-shows',
  'c_core_interactions/04_view_layout_live_snapshots_small_multiples#exact-controls',
  'c_core_interactions/04_view_layout_live_snapshots_small_multiples#linked-cameras',
  'c_core_interactions/04_view_layout_live_snapshots_small_multiples#select-and-edit-the-intended-panel',
  'c_core_interactions/05_dimension_switching_1d_2d_3d#keys-1-2-and-3',
  'c_core_interactions/07_screenshots#connectivity-edges',
  'd_fields_coloring_legends/01_field_types_and_sources#categorical-vs-continuous-what-changes-in-the-app',
  'd_fields_coloring_legends/02_field_selector_ux#deleted-fields-panel-restore-vs-confirm-deletion',
  'd_fields_coloring_legends/02_field_selector_ux#the-one-active-field-rule-obs-vs-gene-expression',
  'd_fields_coloring_legends/03_color_by_behavior#categorical-color-by-discrete-labels',
  'd_fields_coloring_legends/03_color_by_behavior#live-filtering-vs-filter-performance-predictability',
  'd_fields_coloring_legends/03_color_by_behavior#log-scale-coloring-only',
  'd_fields_coloring_legends/03_color_by_behavior#rescale-colorbar-to-slider-range-contrast-control',
  'd_fields_coloring_legends/04_legend_behavior#categorical-legend-checkboxes-swatches-category-tools',
  'd_fields_coloring_legends/04_legend_behavior#log-scale-toggle',
  'e_filtering/01_filtering_mental_model#mental-model-one-sentence',
  'e_filtering/02_outlier_filtering_per_active_field#what-this-filter-is-and-is-not',
  'e_filtering/03_filter_stack_ui_active_filters#practical-path-what-each-control-means-exact-semantics',
  'f_highlighting_selection/02_selection_tools_document_each_tool#tool-overview-choose-quickly',
  'f_highlighting_selection/02_selection_tools_document_each_tool#universal-rules-apply-to-all-tools',
  'f_highlighting_selection/03_highlight_ui#create-categorical-turn-pages-into-a-real-obs-column',
  'f_highlighting_selection/03_highlight_ui#highlight-pages-tabs-alternative-workspaces',
  'h_analysis/02_analysis_ui_overview#page-selection-ui-compare-pages',
  'h_analysis/03_analysis_mode_quick_insights#what-quick-mode-is-for-and-what-it-is-not',
  'h_analysis/04_analysis_mode_detailed_analysis#choosing-the-right-plot-type',
  'h_analysis/04_analysis_mode_detailed_analysis#what-detailed-mode-is-for',
  'h_analysis/05_analysis_mode_correlation_analysis#pearson-vs-spearman',
  'h_analysis/05_analysis_mode_correlation_analysis#what-correlation-mode-is-for',
  'h_analysis/06_analysis_mode_differential_expression_de#performance-settings-when-de-is-slow',
  'h_analysis/06_analysis_mode_differential_expression_de#statistics-exact-implementation',
  'h_analysis/06_analysis_mode_differential_expression_de#what-de-is-for-in-cellucid',
  'h_analysis/07_analysis_mode_gene_signature#inputs-genes-pages',
  'h_analysis/07_analysis_mode_gene_signature#normalization-options-what-they-do',
  'h_analysis/07_analysis_mode_gene_signature#scoring-algorithm-exact',
  'h_analysis/07_analysis_mode_gene_signature#what-a-gene-signature-is-user-facing',
  'h_analysis/08_analysis_mode_genes_panel#clustered-mode',
  'h_analysis/08_analysis_mode_genes_panel#ranked-genes-mode',
  'h_analysis/08_analysis_mode_genes_panel#statistics-what-is-computed',
  'h_analysis/08_analysis_mode_genes_panel#what-marker-genes-is-for',
  'i_vector_field_velocity/02_enabling_overlay_and_selecting_field#availability-states',
  'i_vector_field_velocity/03_core_parameters_document_exact_ui_labels#exact-labels-ranges-and-initial-values',
  'j_community_annotation/01_annotator_guide#connect-to-the-annotation-repo-first-time',
  'j_community_annotation/01_annotator_guide#publish-your-work-direct-push-vs-pull-request',
  'j_community_annotation/01_annotator_guide#pull-latest-what-it-does-and-why-it-matters',
  'j_community_annotation/02_author_guide#build-a-derived-consensus-column-optional-local',
  'j_community_annotation/02_author_guide#export-a-consensus-snapshot-for-downstream-tools',
  'j_community_annotation/02_author_guide#merge-duplicate-suggestions-moderation',
  'j_community_annotation/02_author_guide#tune-consensus-rules-per-column',
  'j_community_annotation/03_ui_reference#consensus-snapshot-local-cache',
  'j_community_annotation/03_ui_reference#manage-annotation-author-only',
  'j_community_annotation/03_ui_reference#profile-optional-and-your-identity-modal',
  'j_community_annotation/index#how-consensus-is-computed',
  'j_community_annotation/index#quickstart-choose-your-path',
  'j_community_annotation/index#where-data-lives-local-vs-github',
  'k_figure_export/02_export_ui_walkthrough#download-options-and-large-dataset-strategies',
  'k_figure_export/02_export_ui_walkthrough#fast-path-export-a-decent-figure-in-2-minutes',
  'k_figure_export/02_export_ui_walkthrough#framing-overlay-crop-mental-model',
  'k_figure_export/02_export_ui_walkthrough#preview-vs-export',
  'k_figure_export/02_export_ui_walkthrough#style-controls-that-affect-export-readability',
  'k_figure_export/02_export_ui_walkthrough#titles-captions-legends-axes',
  'k_figure_export/03_export_formats_and_renderers#decision-table-choose-the-right-mode',
  'l_sessions_sharing/02_what_gets_saved_and_restored#quick-summary-read-this-if-you-only-have-60-seconds',
  'l_sessions_sharing/03_save_restore_ux#fast-path-wet-lab-non-technical-save-my-work',
  'n_benchmarking_performance/02_performance_considerations_what_gets_slow_and_why#rendering-points-measured',
  'n_benchmarking_performance/03_large_dataset_best_practices#fast-path-large-dataset-survival-checklist-copy-paste-mental-defaults',
  'n_benchmarking_performance/05_benchmark_tools#analyze-performance-why-is-it-slow',
  'n_benchmarking_performance/05_benchmark_tools#copy-situation-report-use-this-for-bug-reports',
  'n_benchmarking_performance/05_benchmark_tools#data-patterns-how-to-choose',
  'n_benchmarking_performance/05_benchmark_tools#quick-start-3-minutes',
  'n_benchmarking_performance/06_edge_cases_performance#edge-case-multiview-on-a-large-dataset',
  'n_benchmarking_performance/06_edge_cases_performance#edge-case-two-settings-changed-themselves-when-you-opened-another-dataset',
];

const usedLinks = [...new Set(Object.values(INFO_TIPS).flatMap(tip => tip.links.map(link => `${link.page}#${link.anchor}`)))].sort();

test('the docs links are the pinned, reviewed set', () => {
  assert.deepEqual(usedLinks, [...PINNED_LINKS].sort());
});

// ---------------------------------------------------------------------------
// Resolution against the documentation source, when it is checked out.
// ---------------------------------------------------------------------------

const DOCS_ROOT = process.env.CELLUCID_PYTHON_DOCS
  ?? path.resolve(ROOT, '..', 'cellucid-python', 'docs');
const WEB_APP_DOCS = path.join(DOCS_ROOT, 'user_guide', 'web_app');

/** The text a Markdown heading renders to: markup removed, link text kept. */
function headingText(markdown) {
  return markdown
    .replace(/\{[a-z]+\}`([^`<]*?)(?:\s*<[^>]*>)?`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|\*/g, '')
    .trim();
}

/** docutils `make_id`: the section id Sphinx gives a heading. */
function sectionId(text) {
  const ascii = text
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .join(' ');
  return ascii.replace(/[^a-z0-9]+/g, '-').replace(/^[-0-9]+|-+$/g, '');
}

async function headingIds(page) {
  const markdown = await readFile(path.join(WEB_APP_DOCS, `${page}.md`), 'utf8');
  const ids = new Set();
  let fence = null;
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^(`{3,}|~{3,}|:{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) ids.add(sectionId(headingText(heading[2])));
  }
  return ids;
}

test('every docs link resolves to a page and heading in the documentation', async t => {
  if (!existsSync(WEB_APP_DOCS)) {
    t.skip(`documentation tree not present at ${DOCS_ROOT}`);
    return;
  }
  const missing = [];
  for (const link of usedLinks) {
    const [page, anchor] = link.split('#');
    if (!existsSync(path.join(WEB_APP_DOCS, `${page}.md`))) {
      missing.push(`${page}.md does not exist`);
      continue;
    }
    if (!(await headingIds(page)).has(anchor)) missing.push(`${page} has no heading #${anchor}`);
  }
  assert.deepEqual(missing, []);
});
