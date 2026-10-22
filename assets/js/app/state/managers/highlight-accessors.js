/**
 * @fileoverview Read-only highlight accessors mixed into DataState.
 *
 * Kept in a dedicated module so `highlight-manager.js` can stay focused on page
 * and group state transitions while remaining under the refactoring size limit.
 *
 * A cell's code or value on a field is read from the field object itself
 * (`ui/modules/highlight/annotation-cells.js`), never through an index into
 * this state's inventory: in a grid of views the field a selection gesture
 * reads is the one of the pane it landed in, which need not be the focused
 * view's.
 *
 * @module state/managers/highlight-accessors
 */

export const highlightAccessorMethods = {
  // Get the cell index at a screen position (requires viewer support).
  getCellAtScreenPosition(x, y) {
    if (this.viewer && typeof this.viewer.pickCellAtScreen === 'function') {
      return this.viewer.pickCellAtScreen(x, y);
    }
    return -1;
  }
};
