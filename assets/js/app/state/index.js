/**
 * @fileoverview State layer public exports.
 *
 * The app uses a state coordinator (`DataState`) plus domain managers.
 * Import from this module to avoid depending on internal file paths.
 *
 * @module state/index
 */

export { DataState, createDataState } from './core/data-state.js';

