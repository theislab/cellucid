/**
 * @fileoverview The views read (`views.state`) and the picture of a view
 * (`view.picture`, `app/actions/definitions/reads.js`).
 *
 * The picture is the figure export's: the same snapshot and renderer as a
 * PNG download (`figure-export-engine.js` `renderFigure`), returned to the
 * caller instead of downloaded. The size asked for is the box the plot fits
 * in, as in the export (96 dpi: one figure pixel per CSS pixel): the plot
 * keeps the view's shape inside it, as framed on screen; the picture adds
 * its margins and the legend around it, and says its own size and the
 * plot's. What the
 * figure cannot draw of the view (an overlay, another render mode) is said
 * in `notes`, the warnings a download would ask the person about. A picture
 * with `source: 'screen'` is the view's pane as the screen shows it (the
 * vector field's flow and the connectivity edges included), so an agent
 * tuning an overlay sees what the person sees. A camera path's
 * caption on screen while the path plays is drawn on the screen's
 * picture as the person sees it, and named in every picture's notes.
 *
 * @module app/reads/views
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { buildOverlayFidelityWarnings, readShownVectorFieldId } from '../ui/modules/figure-export/utils/overlay-fidelity.js';
import { buildRenderModeFidelityWarnings } from '../ui/modules/figure-export/utils/render-mode.js';
import {
  buildViewerBackgroundFidelityWarnings,
  readActiveReferenceGridAppearance,
} from '../ui/modules/figure-export/utils/viewer-background.js';
import { kindWord } from '../actions/targets/fields.js';
import { formatCountOf, formatPercent } from '../../utils/format-units.js';
import { openViewIds, resolveViewName, viewLabelOf, viewNameOf } from '../actions/targets/views.js';
import { runAfterNextFrame } from '../../rendering/frame-phases.js';
import { prefersReducedMotion } from '../../utils/reduced-motion.js';
import { readShownCaption } from '../ui/modules/cinematic-camera/captions.js';
import { pngSidesOf } from '../ui/modules/figure-export/utils/png-metadata.js';
import { devicePxOf, figureSizeText, formatMm, mmOfFigurePx } from '../ui/modules/figure-export/utils/figure-size.js';
import { applyColorblindSimulationToImageData } from '../ui/modules/figure-export/utils/colorblindness.js';
import { base64OfBytes } from '../../utils/byte-text.js';
import { NO_DATASET_OPEN } from '../ui/no-dataset.js';

/** The title a person reads on a view's chip: the live view's label or a kept view's. */
function viewTitleOf(viewer, viewId) {
  if (viewId === 'live') return viewer.getLiveViewLabel();
  return viewer.getSnapshotViews().find(view => view.id === viewId)?.label ?? String(viewId);
}

/**
 * The camera path's caption drawn on a picture of the screen as the screen
 * shows it (`.cinematic-caption`): a compact dark label, low and centred.
 */
function drawCaption(context, caption, width, height) {
  const size = Math.max(11, Math.round(height * 0.035));
  context.font = `600 ${size}px Arial, Helvetica, sans-serif`;
  const textWidth = Math.min(context.measureText(caption).width, width * 0.8);
  const padX = size * 0.9;
  const padY = size * 0.45;
  const boxWidth = textWidth + padX * 2;
  const boxHeight = size + padY * 2;
  const x = (width - boxWidth) / 2;
  const y = height - boxHeight - Math.round(height * 0.07);
  // As `.cinematic-caption` draws it: black at --opacity-60, white text.
  context.fillStyle = 'rgba(0, 0, 0, 0.6)';
  context.fillRect(x, y, boxWidth, boxHeight);
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(caption, width / 2, y + boxHeight / 2, width * 0.8);
}

/** One figure pixel per CSS pixel: the PNG is exactly `width × height`. */
const PICTURE_DPI = 96;

/**
 * @param {{state: object, viewer: object, documentRef: Document, getFigureExport: () => ({renderFigure: Function}|null)}} owners
 */
export function createViewReads({ state, viewer, documentRef, getFigureExport }) {
  function sourceOfActiveField(viewId) {
    if (viewId === state.getActiveViewId()) return state.activeFieldSource ?? null;
    return state.viewContexts?.get(String(viewId))?.activeFieldSource ?? null;
  }

  function viewsState() {
    if (!(state.pointCount > 0)) throw new ActionRefused(NO_DATASET_OPEN, { code: 'unavailable' });
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
        label: viewLabelOf(viewer, id),
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
      reduced_motion: prefersReducedMotion(),
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

  /**
   * What the screen and a figure draw over the coloring: the cells of the
   * highlight page shown, in the highlight's color. A picture says so, so a color
   * there is not read as the coloring's (a highlight's bright patches over a
   * gene's color scale would be taken for high expression).
   */
  function highlightNotes() {
    const page = state.getActivePage?.() ?? null;
    if (page === null) return [];
    const cells = state.getHighlightedCellCountForPage(page.id);
    if (!(cells > 0)) return [];
    const are = cells === 1 ? 'is' : 'are';
    return [`The ${formatCountOf(cells, 'cell')} highlighted on page "${page.name}" ${are} drawn over the coloring in the highlight's color: their color there is the highlight's, not the coloring's.`];
  }

  /**
   * The view's pane as the screen shows it now (`source: 'screen'`): the
   * viewer's canvas (its drawing buffer is kept between frames,
   * `rendering/viewer.js`) cut to the part of the pane not under the
   * sidebar, after the next frame, fitted into width × height. What the
   * figure cannot draw (the vector field's flow, the connectivity edges) is
   * here as drawn; a moving flow is caught at that instant.
   */
  async function screenPicture(viewId, width, height, signal) {
    const layout = viewer.getPresentedLayout?.() ?? null;
    const pane = layout?.panes?.find(each => each.viewId === viewId) ?? null;
    if (pane === null) {
      throw new ActionRefused(
        `${viewNameOf(viewer, viewId)} is not on the screen now (the layout shows ${(layout?.panes ?? []).map(each => viewNameOf(viewer, each.viewId)).join(', ') || 'no view'}); show it first (view_focus, or the grid layout), or take its picture with source "figure".`,
        { code: 'unavailable' },
      );
    }
    const canvas = documentRef.getElementById('glcanvas');
    const bounds = canvas?.getBoundingClientRect?.() ?? null;
    if (canvas === null || bounds === null || !(bounds.width > 0) || !(canvas.width > 0)) {
      throw new ActionRefused('The viewer draws nothing on screen now; take the picture with source "figure".', { code: 'unavailable' });
    }
    await new Promise(resolve => runAfterNextFrame(resolve));
    signal?.throwIfAborted?.();
    const scaleX = canvas.width / bounds.width;
    const scaleY = canvas.height / bounds.height;
    const sx = Math.round(pane.visibleCssLeft * scaleX);
    const sy = Math.round(pane.visibleCssTop * scaleY);
    const sw = Math.max(1, Math.round(pane.visibleCssWidth * scaleX));
    const sh = Math.max(1, Math.round(pane.visibleCssHeight * scaleY));
    const fit = Math.min(width / sw, height / sh);
    const out = documentRef.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * fit));
    out.height = Math.max(1, Math.round(sh * fit));
    const context = out.getContext('2d');
    context.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const caption = readShownCaption(documentRef);
    if (caption !== null) drawCaption(context, caption, out.width, out.height);
    const blob = await new Promise((resolve, reject) => out.toBlob(
      value => (value === null ? reject(new Error('The screen picture could not be encoded as PNG.')) : resolve(value)),
      'image/png',
    ));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The screen has no legend (the parameter says so); nothing is left out of what it shows.
    return {
      png: base64OfBytes(bytes), width: out.width, height: out.height,
      plot: { width: out.width, height: out.height }, view: viewNameOf(viewer, viewId), label: viewLabelOf(viewer, viewId),
      notes: [...highlightNotes(), ...(caption === null ? [] : [`The camera path is playing; its caption "${caption}" is drawn as on screen.`])],
    };
  }

  /**
   * The figure Export would download now (`source: 'export'`): the Figure
   * export panel's settings — size, frame, background, fonts, title, legends,
   * every view as lettered panels while Export all views is on — drawn by the
   * renderer of a download at 96 dpi, scaled down (never up) into
   * width × height. What an agent preparing a figure checks before the
   * person downloads it.
   */
  /**
   * The figure's printed size, and when it is wider than the width the
   * settings ask for, why. The settings give the figure's width in
   * millimetres and the figure fills it at its own height (each plot keeps
   * its view's shape, or its frame's): the note says millimetres, so an agent
   * never turns the figure's pixels into printed size itself.
   */
  function sizeNotes(figure, asked, dpi, legendMovedBelow = false) {
    const notes = [`The figure is ${figureSizeText(figure)} as printed (its text at its point sizes); a PNG at ${dpi} dpi is ${devicePxOf(figure.width, dpi)} × ${devicePxOf(figure.height, dpi)} px, an SVG the same size in millimetres.`];
    if (figure.width > asked.width) {
      notes.push(`It is wider than the ${formatMm(mmOfFigurePx(asked.width))} mm asked: its plots' least readable size, a title or a legend needs more. A narrower legend (legend_position bottom) or smaller text keeps it to the width.`);
    } else {
      notes.push('Its height follows from its plots\' shapes (each keeps its view\'s, or its frame\'s: frame "cells" fits the cells).');
    }
    if (legendMovedBelow) {
      notes.push('Its legend stands below the plot: beside it, the figure would be wider than asked.');
    }
    return notes;
  }

  /** A camera path's caption on screen now, which a figure leaves out. */
  function captionNotes() {
    const caption = readShownCaption(documentRef);
    return caption === null ? [] : [`The camera path is playing with the caption "${caption}" on screen; a figure leaves captions out (source "screen" shows it).`];
  }

  async function exportPicture(view, width, height, signal) {
    if (view !== undefined) {
      throw new ActionRefused(
        'A picture with source "export" draws what Export would download (every view while Export all views is on, else the selected view); leave view out, or take one view\'s picture with source "figure".',
        { code: 'bad-value' },
      );
    }
    const figureExport = getFigureExport();
    if (figureExport === null || typeof figureExport.renderExportPicture !== 'function') {
      throw new ActionRefused('The figure export is not available on this page.', { code: 'unavailable' });
    }
    const { blob, notes, plot, asked, dpi, legendMovedBelow = false, colorblindMode = 'none' } = await figureExport.renderExportPicture({ signal });
    const bitmap = await createImageBitmap(blob);
    signal?.throwIfAborted?.();
    // Drawn at 96 dpi: one pixel a figure pixel (1/96 inch).
    const figure = { width: bitmap.width, height: bitmap.height };
    const fit = Math.min(1, width / figure.width, height / figure.height);
    const out = documentRef.createElement('canvas');
    out.width = Math.max(1, Math.round(figure.width * fit));
    out.height = Math.max(1, Math.round(figure.height * fit));
    // The preview's color-vision simulation, as the panel's preview draws it: an agent asked to check a
    // figure for color-blind readers could not otherwise see it. Export itself writes the true colors.
    const simulated = colorblindMode !== 'none';
    // Its pixels are read back once: said to the canvas, so it keeps them where they can be read.
    const context = out.getContext('2d', simulated ? { willReadFrequently: true } : undefined);
    context.drawImage(bitmap, 0, 0, out.width, out.height);
    bitmap.close?.();
    if (simulated) {
      const pixels = context.getImageData(0, 0, out.width, out.height);
      applyColorblindSimulationToImageData(pixels, colorblindMode);
      context.putImageData(pixels, 0, 0);
    }
    const scaled = fit < 1 || simulated ? await new Promise((resolve, reject) => out.toBlob(
      value => (value === null ? reject(new Error('The figure picture could not be encoded as PNG.')) : resolve(value)),
      'image/png',
    )) : blob;
    const bytes = new Uint8Array(await scaled.arrayBuffer());
    const size = pngSidesOf(bytes);
    // The engine fits no single plot when it composes every view (a grid).
    const allViews = plot === null;
    const scale = fit < 1 ? `, shown at ${formatPercent(fit * 100)} (${size.width} × ${size.height})` : '';
    const viewId = state.getActiveViewId();
    return {
      png: base64OfBytes(bytes), width: size.width, height: size.height,
      plot: allViews ? null : { width: plot.width * fit, height: plot.height * fit },
      view: allViews ? null : viewNameOf(viewer, viewId),
      label: allViews ? null : viewLabelOf(viewer, viewId),
      notes: [...sizeNotes(figure, asked, dpi, legendMovedBelow), `The picture is the figure at 96 dpi (${figure.width} × ${figure.height} px)${scale}.`, ...(simulated ? [`Drawn as a reader with ${colorblindMode} sees it (the preview's color-vision simulation); Export writes the true colors.`] : []), ...notes, ...highlightNotes(), ...captionNotes()],
    };
  }

  async function picture({ view, source = 'figure', width, height, legend }, { signal }) {
    if (!(state.pointCount > 0)) throw new ActionRefused(NO_DATASET_OPEN, { code: 'unavailable' });
    if (source === 'export') return exportPicture(view, width, height, signal);
    if (source === 'screen') {
      const viewId = view === undefined ? state.getActiveViewId() : resolveViewName(viewer, view);
      return screenPicture(viewId, width, height, signal);
    }
    const figureExport = getFigureExport();
    if (figureExport === null || typeof figureExport.renderFigure !== 'function') {
      throw new ActionRefused('Pictures are drawn by the figure export, which is not available on this page.', { code: 'unavailable' });
    }
    const viewId = view === undefined ? state.getActiveViewId() : resolveViewName(viewer, view);
    const overlays = buildOverlayFidelityWarnings({
      documentRef,
      connectivityVisible: viewer.getShowConnectivity() && viewer.hasConnectivityData(),
    });
    const notes = [
      ...buildRenderModeFidelityWarnings(documentRef),
      ...buildViewerBackgroundFidelityWarnings(documentRef),
      ...overlays,
    ].map(warning => `${warning.title}: ${warning.detail}`);
    // The figure's advice is for a download; a picture can show the overlay.
    if (overlays.some(warning => warning.fix !== undefined)) {
      notes.push('To see it as drawn, take the picture with source "screen" (the view on screen now, overlays included).');
    }
    // The vector field is drawn as a still picture of its flow.
    const shownField = readShownVectorFieldId(documentRef);
    if (shownField !== null) {
      notes.push(`The vector field ${shownField} is drawn as arrows on a grid (the mean of nearby cells' vectors, a still picture of the flow); source "screen" shows its moving particles.`);
    }
    // The figure draws the highlight as the screen does.
    notes.push(...highlightNotes());
    // A camera path's caption is on the screen, not in a figure.
    notes.push(...captionNotes());
    const { blob, plot } = await figureExport.renderFigure({
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
    const size = pngSidesOf(bytes);
    return {
      png: base64OfBytes(bytes), width: size.width, height: size.height,
      plot: { width: plot.width, height: plot.height }, view: viewNameOf(viewer, viewId), label: viewLabelOf(viewer, viewId), notes,
    };
  }

  return { viewsState, picture };
}
