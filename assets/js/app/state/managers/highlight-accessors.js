/**
 * @fileoverview Read-only highlight accessors mixed into DataState.
 *
 * Kept in a dedicated module so `highlight-manager.js` can stay focused on page
 * and group state transitions while remaining under the refactoring size limit.
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
  },

  // Get category index for a cell.
  getCategoryForCell(cellIndex, fieldIndex, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'category') return -1;
    const codes = field.codes || [];
    if (cellIndex < 0 || cellIndex >= codes.length) return -1;
    return codes[cellIndex];
  },

  // Get value for a cell in a continuous field.
  getValueForCell(cellIndex, fieldIndex, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'continuous') return null;
    const values = field.values || [];
    if (cellIndex < 0 || cellIndex >= values.length) return null;
    return values[cellIndex];
  },

  // Get all highlighted cell indices (unique, merged from all groups).
  getAllHighlightedCellIndices() {
    const set = new Set();
    for (const group of this.highlightedGroups) {
      if (group.cellIndices) {
        for (const idx of group.cellIndices) {
          set.add(idx);
        }
      }
    }
    return Array.from(set);
  }
};

