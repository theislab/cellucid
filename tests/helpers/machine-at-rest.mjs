/**
 * This machine's own speed, held for a test file, imported for its effect
 * (`import './helpers/machine-at-rest.mjs'`).
 *
 * An opening's plan weighs the speed of the machine it runs on besides the
 * link: how fast chunks decode (`progressive-open.js` `decodingRate`), how
 * long making every cell's order takes (`subsample-plan.js` `geneSampleOf`,
 * one pass timed), how fast a kept gene index was read
 * (`sparse-column-index.js` `keptReadMs`) and what a gene index pass's work
 * cost an entry (`prefix-column-index.js` `PassRates`). Measured, each
 * follows how busy the machine is, and carries over from whatever an
 * earlier test in the same file did. A contract test asserting which
 * opening a link plans then passes alone and fails beside other work: with
 * pytest and R checks running, "a fast link: file order" opened every cell
 * in a `blocks` order (`gene-sample-contract.test.mjs`, 2026-11-04) -- its
 * plan turns below about 600 decoded bytes a millisecond, and the file's
 * earlier tests measure about 6,600 on an idle machine. An order whose
 * sample brings the first gene 142 ms sooner (`orderPays`) turns likewise
 * once its pass over 6,000 cells stalls for 20 ms.
 *
 * So a test file whose assertions follow from a plan holds them
 * (`utils/machine.js` `holdMachine`, `MACHINE_AT_REST`): decoding at
 * `DECODE_BYTES_PER_MS_AT_REST` (fast enough that it never binds these
 * small stores' plans, as on a machine at rest), the order made in no time
 * worth pricing, and no kept read and no index pass measured yet (each
 * plan as a reader's first).
 *
 * The link is not held here: these files model their links themselves (a
 * clock of their own, a rate set on the meter, answers delayed), and a held
 * link would take those models' place. A test whose host is a function in
 * this process, with no time of its own, measures only how busy the machine
 * is (`open-cells-folder-reuse.test.mjs`: with every interval timed 40 times
 * longer, genes read for 8 of 900 cells, 2026-11-06): it holds the link
 * too, with `holdMachineAtRest({link: LINK_AT_REST})`.
 *
 * A test of a measurement itself holds nothing of it
 * (`holdMachineAtRest({decodeBytesPerMs: undefined})` measures decoding
 * again; `holdMachine(null)` everything), and puts the rest back when it
 * ends (`holdMachineAtRest()`); one of decoding's price passes its own rate
 * (`decodeBytesPerMs`).
 *
 * @module tests/helpers/machine-at-rest
 */

import { holdMachine } from '../../assets/js/utils/machine.js';

/** Decoded bytes a millisecond decoding is held at, every decoder together: 1 GB/s. */
export const DECODE_BYTES_PER_MS_AT_REST = 1e6;

/** A host a round trip of 2 ms away delivering 32 MB/s: a link no plan of these small stores is bound by. */
export const LINK_AT_REST = Object.freeze({ latencyMs: 2, bytesPerMs: 32_000 });

/** The measures every file importing this module holds (`utils/machine.js`). */
export const MACHINE_AT_REST = Object.freeze({
  decodeBytesPerMs: DECODE_BYTES_PER_MS_AT_REST,
  orderMadeMs: 0,
  keptReadBytesPerMs: null,
  indexPassMs: null,
});

/**
 * Hold this machine at rest, with `measures` in place of or beside
 * `MACHINE_AT_REST`'s; a measure given as undefined is measured.
 *
 * @param {Object<string, unknown>} [measures]
 */
export function holdMachineAtRest(measures = {}) {
  const held = { ...MACHINE_AT_REST, ...measures };
  for (const name of Object.keys(held)) if (held[name] === undefined) delete held[name];
  holdMachine(held);
}

holdMachineAtRest();
