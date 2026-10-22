/**
 * @fileoverview The sidebar and the plot area it leaves uncovered.
 *
 * The sidebar toggle, its resize handle and the selection bar are static
 * markup, painted with the first frame. On a phone the open sidebar is a
 * full-screen sheet whose ✕ is the only way to the plot, so the toggle must
 * work from that first frame, not from the end of the first dataset load,
 * which can take seconds. `main.js` therefore wires this right after the
 * viewer exists, before any startup await, and tears it down with the
 * application.
 *
 * The sidebar publishes the part of the plot it covers; the viewer lays its
 * views out in the rest (the presented area), and the selection bar centres
 * itself in that same presented layout.
 *
 * @module ui/core/sidebar-layout
 */

import { initSidebarControls } from '../modules/sidebar-controls.js';
import { initSelectBarPlacement } from '../modules/select-bar-placement.js';

/**
 * @param {object} options
 * @param {Document} options.documentOwner
 * @param {{
 *   setViewportLeftOcclusionRatio: (ratio: number) => void,
 *   onPresentedLayoutChange: (listener: (layout: Object) => void) => () => void
 * }} options.viewer
 * @returns {{destroy: () => void}}
 */
export function initSidebarLayout({ documentOwner, viewer }) {
  const byId = id => documentOwner.getElementById(id);
  const selectBarPlacement = initSelectBarPlacement({ bar: byId('select-bar') });
  const sidebarControls = initSidebarControls({
    dom: {
      el: byId('sidebar'),
      toggleBtn: byId('sidebar-toggle'),
      resizeHandle: byId('sidebar-resize-handle'),
      canvas: byId('glcanvas'),
    },
    onViewportOcclusionChange: viewer.setViewportLeftOcclusionRatio,
  });
  const unsubscribeSelectBarPlacement = viewer.onPresentedLayoutChange(
    layout => selectBarPlacement.place(layout)
  );
  return {
    destroy() {
      sidebarControls.destroy();
      unsubscribeSelectBarPlacement();
      selectBarPlacement.destroy();
    },
  };
}
