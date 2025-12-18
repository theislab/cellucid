/**
 * Analysis UI Shared Components
 *
 * Centralized shared components used across all analysis type UIs:
 * - PageSelectorComponent: Multi-select page tabs with color customization
 * - VariableSelectorComponent: Variable selection with mutual exclusivity
 * - FigureContainer: Plot container with preview, modal, and export
 *
 * These components extract common patterns from DetailedAnalysisUI
 * for reuse across all analysis types (DE, Signature, Correlation, etc.)
 */

// =============================================================================
// SHARED COMPONENTS
// =============================================================================

export {
  PageSelectorComponent,
  createPageSelectorComponent
} from './page-selector.js';

export {
  VariableSelectorComponent,
  createVariableSelectorComponent
} from './variable-selector.js';

export {
  FigureContainer,
  createFigureContainer
} from './figure-container.js';

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

import { PageSelectorComponent } from './page-selector.js';
import { VariableSelectorComponent } from './variable-selector.js';
import { FigureContainer } from './figure-container.js';

export default {
  PageSelectorComponent,
  VariableSelectorComponent,
  FigureContainer
};
