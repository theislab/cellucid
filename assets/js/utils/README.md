# `utils/`: shared primitives (L0)

Pure helpers with no DOM state of their own and no app knowledge, importable
from the page and from every worker. A module here imports only other
`utils/` modules (`machine.js` also `../workers/worker-script.js`, of the
same layer, to hand what it holds to the workers a thread starts). Before writing a helper anywhere else, look here first:
parallel copies are the most common tidiness finding in this codebase.

| Module | Use it for |
| --- | --- |
| `abort.js` | Cancellation everywhere (page, reader, decode, analysis, figure-export workers): `cancel`, `isCancellation`, `throwIfAborted`, `awaitWithSignal`, `onAbort` (the only way to wait on a signal: it calls back at once when the signal has already aborted, and returns a remover), `SharedWork` (work shared by several askers, stopped once all withdraw). Do not write private copies of these. |
| `errors.js` | How a failure reaches the person exactly once (`markReported`, `isReported`, `settleQuietly`, `failureText`). |
| `error-wire.js` | The one wire format of a failed request across a thread boundary (`toWire`, `fromWire`). |
| `large-arrays.js` | Typed arrays larger than one `ArrayBuffer`, and moving any typed array between threads in pieces. |
| `radix-order.js` | Ordering millions of cells by a key without a comparator sort (`orderByKey`, `sortUint32`). |
| `string-index.js` | Strings to indices at scale (cell names to cells, labels to codes). |
| `format-units.js` | Every count, byte size, rate and duration shown to the person. |
| `exact-record.js` | Records that hold exactly the keys they may. |
| `origin-allowlist.js` | A Worker's exact `ALLOWED_ORIGINS` list and the loopback hosts where plain HTTP is accepted (`parseOriginAllowlist`, `isLoopbackHostname`); the community-annotation Worker imports it, the agent relay's copy is held to it by test. |
| `deadline.js`, `yield-macrotask.js`, `person-wait.js` | Timers released on settle, yielding long loops, waits on the person. |
| `indexed-db-store.js`, `indexed-db-database.js` | The per-viewer IndexedDB records: one store as key-value (local file handles, decoder decisions), several in one transaction (the history's saved states). |
| `debug.js` | The shared debug logger (`localStorage.CELLUCID_DEBUG`). |
| `machine.js` | The machine as plans read it: every rate measured of the machine or the link that a plan weighs (the link the reader plans on, the decoding rate, the order time, the kept-read rate, the index pass rates, the opening cost, the cores) is read with `measureOf` under its name, so a test or a benchmark holds it (`holdMachine`) on the page and in every worker. A new measured rate that feeds a plan gets a name here, never a pin of its own. |
| `theme-manager.js`, `style-manager.js` | Theme and design-token access. |

`../workers/` holds `worker-script.js` (where each worker starts from: its
source on a local server, its generated bundle in `assets/workers/`
elsewhere; and what a thread hands every worker it starts, `handToWorkers`) and `idle-retirement.js` (the one idle-lifetime rule of the
worker pools).

Other utility folders exist today (`app/utils/`, `app/analysis/shared/`);
their merge into this folder is stage 1 of the reorganisation plan
(`cellucid-private/plans/audit-2026-10-28/code-organisation.md` §B).

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/27_decisions_memory_model.md`. Update them in the same change as the code.
