/**
 * Base Classes for Analysis Type UIs
 *
 * Provides abstract base classes for different patterns:
 * - FormBasedAnalysisUI: For form + results pattern (DE, Signature)
 *
 * @module analysis-types/base
 */

export {
  FormBasedAnalysisUI,
  createFormBasedAnalysisUI
} from './form-based-analysis.js';

// Re-export BaseAnalysisUI for convenience
export { BaseAnalysisUI } from '../../base-analysis-ui.js';
