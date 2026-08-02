/**
 * Analysis UI Shared Components
 *
 * Centralized shared components used across all analysis type UIs:
 * - PageSelectorComponent: Multi-select page tabs with color customization
 * - VariableSelectorComponent: Variable selection with mutual exclusivity
 *
 * These components extract common patterns from DetailedAnalysisUI
 * for reuse across all analysis types (DE, Signature, Correlation, etc.)
 */

// =============================================================================
// SHARED COMPONENTS
// =============================================================================

export {
  PageSelectorComponent,
} from './page-selector.js';

export {
  VariableSelectorComponent,
  createVariableSelectorComponent
} from './variable-selector.js';

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

import { PageSelectorComponent } from './page-selector.js';
import { VariableSelectorComponent } from './variable-selector.js';

export default {
  PageSelectorComponent,
  VariableSelectorComponent
};
