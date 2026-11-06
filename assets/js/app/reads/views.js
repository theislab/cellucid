/**
 * @fileoverview The views read (`views.state`) and the picture of a view
 * (`view.picture`, `app/actions/definitions/reads.js`).
 *
 * The picture is the figure export's: the same snapshot and renderer as a
 * PNG download (`figure-export-engine.js` `renderFigure`), returned to the
 * caller instead of downloaded. The size asked for is the plot's, as in the
 * export (96 dpi: one figure pixel per CSS pixel); the picture adds its
 * margins and the legend around it, and says the size it is. What the
 * figure cannot draw of the view (an overlay, another render mode) is said
 * in `notes`, the warnings a download would ask the person about.
 *
 * @module app/reads/views
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { buildOverlayFidelityWarnings } from '../ui/modules/figure-export/utils/overlay-fidelity.js';
import { buildRenderModeFidelityWarnings } from '../ui/modules/figure-export/utils/render-mode.js';
import {
  buildViewerBackgroundFidelityWarnings,
  readActiveReferenceGridAppearance,
} from '../ui/modules/figure-export/utils/viewer-background.js';
import { kindWord } from '../actions/targets/fields.js';
import { openViewIds, resolveViewName, viewNameOf } from '../actions/targets/views.js';

/** The title a person reads on a view's chip: the live view's label or a kept view's. */
function viewTitleOf(viewer, viewId) {
  if (viewId === 'live') return viewer.getLiveViewLabel();
  return viewer.getSnapshotViews().find(view => view.id === viewId)?.label ?? String(viewId);
}

/** One figure pixel per CSS pixel: the PNG is exactly `width × height`. */
const PICTURE_DPI = 96;

/** A PNG's width and height, from its header (IHDR, the first chunk). */
function pngSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The bytes as base64, in pieces (a long argument list overflows the stack). */
function base64Of(bytes) {
  let binary = '';
  const piece = 0x8000;
  for (let at = 0; at < bytes.length; at += piece) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + piece));
  }
  return btoa(binary);
}

/**
 * @param {{state: object, viewer: object, documentRef: Document, getFigureExport: () => ({renderFigure: Function}|null)}} owners
 */
export function createViewReads({ state, viewer, documentRef, getFigureExport }) {
  function sourceOfActiveField(viewId) {
    if (viewId === state.getActiveViewId()) return state.activeFieldSource ?? null;
    return state.viewContexts?.get(String(viewId))?.activeFieldSource ?? null;
  }

  function viewsState() {
    if (!(state.pointCount > 0)) throw new ActionRefused('No dataset is open yet.', { code: 'unavailable' });
    const activeId = state.getActiveViewId();
    const layout = viewer.getViewLayout();
    const views = openViewIds(viewer).map(id => {
      const field = state.getFieldForView(id);
      const source = sourceOfActiveField(id);
      const embedding = state.describeViewEmbedding?.(id) ?? null;
      const filters = state.getFilterSummaryForView(id).filter(line => line !== 'No filters active');
      let camera = null;
      try {
        camera = viewer.getViewCameraState(id);
      } catch {
        camera = null;
      }
      return {
        name: viewNameOf(viewer, id),
        title: viewTitleOf(viewer, id),
        live: id === 'live',
        active: id === activeId,
        representation: embedding === null ? null : { name: embedding.name, dimension: embedding.dimension },
        colored_by: field === null || source === null ? null : { source, key: field.key, kind: kindWord(field.kind) },
        filters,
        camera,
      };
    });
    const pages = state.getHighlightPages();
    const activePage = state.getActivePage?.() ?? null;
    return {
      active: viewNameOf(viewer, activeId),
      layout: layout.mode,
      cameras_locked: viewer.getCamerasLocked(),
      views,
      highlights: {
        active_page: activePage?.name ?? null,
        pages: pages.map(page => ({
          name: page.name,
          cells: state.getHighlightedCellCountForPage(page.id),
          groups: page.highlightedGroups.map(group => ({
            name: String(group.label ?? group.id),
            cells: group.cellCount ?? group.cellIndices?.length ?? 0,
            enabled: group.enabled !== false,
          })),
        })),
      },
    };
  }

  async function picture({ view, width, height, legend }, { signal }) {
    if (!(state.pointCount > 0)) throw new ActionRefused('No dataset is open yet.', { code: 'unavailable' });
    const figureExport = getFigureExport();
    if (figureExport === null || typeof figureExport.renderFigure !== 'function') {
      throw new ActionRefused('Pictures are drawn by the figure export, which is not available on this page.', { code: 'unavailable' });
    }
    const viewId = view === undefined ? state.getActiveViewId() : resolveViewName(viewer, view);
    const notes = [
      ...buildRenderModeFidelityWarnings(documentRef),
      ...buildViewerBackgroundFidelityWarnings(documentRef),
      ...buildOverlayFidelityWarnings({
        documentRef,
        connectivityVisible: viewer.getShowConnectivity() && viewer.hasConnectivityData(),
      }),
    ].map(warning => `${warning.title}: ${warning.detail}`);
    const { blob } = await figureExport.renderFigure({
      axisLabelFontSizePx: 12,
      background: 'viewer',
      backgroundColor: '#ffffff',
      centroidLabelFontSizePx: 12,
      crop: null,
      depthSort3d: true,
      dpi: PICTURE_DPI,
      emphasizeSelection: false,
      exportAllViews: false,
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSizePx: 12,
      format: 'png',
      height,
      includeAxes: false,
      includeLegend: legend,
      legendFontSizePx: 12,
      legendPosition: 'right',
      optimizedTargetCount: null,
      referenceGrid: readActiveReferenceGridAppearance(documentRef),
      selectionMutedOpacity: 0.15,
      showOrientation: false,
      signal,
      strategy: null,
      tickFontSizePx: 12,
      title: '',
      titleFontSizePx: 15,
      width,
      xLabel: '',
      yLabel: '',
    }, { viewId });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const size = pngSize(bytes);
    return {
      png: base64Of(bytes), width: size.width, height: size.height,
      plot: { width, height }, view: viewNameOf(viewer, viewId), notes,
    };
  }

  return { viewsState, picture };
}
