/**
 * @fileoverview Every analysis the Analysis panel offers, once: its id (the
 * panel's mode), the name actions and tools call it by, its title, and its
 * options schema (null for the analyses without a Run button, which follow
 * their pages). The analysis actions (`app/actions/definitions/analysis.js`)
 * are derived from this list and the schemas, so a new option needs no
 * action code and a new analysis is one entry here.
 *
 * Pure (no DOM): importable in Node, where the action catalog is built.
 *
 * @module analysis/options/analysis-modes
 */

import { compositionOptions } from './composition-options.js';
import { CORRELATION_OPTIONS } from './correlation-options.js';
import { DE_OPTIONS } from './de-options.js';
import { dotplotOptions } from './dotplot-options.js';
import { MARKER_OPTIONS } from './marker-options.js';
import { SIGNATURE_OPTIONS } from './signature-options.js';

export const ANALYSIS_MODES = Object.freeze([
  { id: 'genesPanel', name: 'markers', title: 'Marker genes', options: MARKER_OPTIONS },
  { id: 'differential', name: 'differential', title: 'Differential expression', options: DE_OPTIONS },
  { id: 'dotplot', name: 'dotplot', title: 'Dot plot', options: dotplotOptions },
  { id: 'signature', name: 'signature', title: 'Gene signature', options: SIGNATURE_OPTIONS },
  { id: 'composition', name: 'composition', title: 'Composition', options: compositionOptions },
  { id: 'simple', name: 'quick', title: 'Quick', options: null },
  { id: 'detailed', name: 'detailed', title: 'Detailed', options: null },
  { id: 'correlation', name: 'correlation', title: 'Correlation', options: CORRELATION_OPTIONS },
].map(mode => Object.freeze(mode)));

/** The analysis an action names (`markers`), or undefined. */
export function analysisModeNamed(name) {
  return ANALYSIS_MODES.find(mode => mode.name === name);
}

/** The analysis of a panel mode id (`genesPanel`), or undefined. */
export function analysisModeOfId(id) {
  return ANALYSIS_MODES.find(mode => mode.id === id);
}
