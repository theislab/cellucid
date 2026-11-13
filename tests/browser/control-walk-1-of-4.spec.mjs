/**
 * Share 1 of 4 of the control walk (`helpers/control-walk.mjs`): every
 * control that changes state makes exactly one step, and undo puts the state
 * back exactly. The shares hold every test of the walk once between them,
 * filled by weight (`helpers/control-walk-parts.mjs`).
 */
import { test } from './helpers/test.mjs';
import { declareWalkTests } from './helpers/control-walk.mjs';

declareWalkTests(test, import.meta.url);
