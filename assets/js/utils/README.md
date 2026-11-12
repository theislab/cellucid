# `utils/`: shared primitives (L0)

Pure helpers with no DOM state of their own and no app knowledge, importable
from the page and from every worker. A module here imports only other
`utils/` modules (`machine.js` also `../workers/worker-script.js`, of the
same layer, to hand what it holds to the workers a thread starts). Before writing a helper anywhere else, look here first:
parallel copies are the most common tidiness finding in this codebase.

| Module | Use it for |
| --- | --- |
| `abort.js` | Cancellation everywhere (page, reader, decode, analysis, figure-export workers): `cancel`, `isCancellation`, `throwIfAborted`, `awaitWithSignal`, `onAbort` (the only way to wait on a signal: it calls back at once when the signal has already aborted, and returns a remover), `SharedWork` (work shared by several askers, stopped once all withdraw), `isAbortSignal` / `requireSignal` / `requireSignalOrNull` (whether a value is a signal: the platform's brand check, never `instanceof` or its members). Do not write private copies of these (`tests/one-implementation-contract.test.mjs`). |
| `backoff.js` | The growing wait before trying again after a failure (`backoffDelayMs`: doubled per attempt up to a ceiling, equal jitter): the chat bar's provider calls and the relay link's reconnection. A host's own wait (`Retry-After`) and rate limits are not this (`formats/io/hosts.js`). |
| `errors.js` | How a failure reaches the person exactly once (`markReported`, `isReported`, `settleQuietly`, `failureText`). |
| `listener-set.js` | Whoever must be told of a change (`createListenerSet(name)`: `add` returns an idempotent unsubscribe, `notify`, `notifyWhile` for news a listener can make stale, `delete`, `clear`, `size`): every listener is told, one that throws is reported once on the console naming the set (`reportListenerFailure`, also `onAbort`'s), a notice reaches who was in when it began. `app/utils/event-emitter.js` builds on it. Never a `Set` of callbacks and a loop of your own (`tests/one-implementation-contract.test.mjs`); callbacks whose results are used (awaited, passed on) are not listeners. |
| `error-wire.js` | The one wire format of a failed request across a thread boundary (`toWire`, `fromWire`). |
| `large-arrays.js` | Typed arrays larger than one `ArrayBuffer`, and moving any typed array between threads in pieces. |
| `radix-order.js` | Ordering millions of cells by a key without a comparator sort (`orderByKey`, `sortUint32`). |
| `string-index.js` | Strings to indices at scale (cell names to cells, labels to codes). |
| `text-case.js` | A first letter upper or lower case: `upperFirst` (a sentence starts), `lowerFirst` (it goes on; a name in capitals such as "PCA" kept). Never `charAt(0).toUpperCase()` by hand (`tests/one-implementation-contract.test.mjs`). |
| `format-units.js` | Every count (exact and compact, "4M"), byte size, rate, duration, percent and p-value shown to the person. |
| `nice-ticks.js` | Axis ticks at 1/2/5 × 10^n (`niceNumbers`): figure export's axes and the analysis plots that set their own ticks (the volcano's, beside its +∞ band). |
| `exact-record.js` | Records that hold exactly the keys they may. |
| `hex-color.js` | Every color read from or written as hex text (`HEX_COLOR` the lowercase `#rrggbb` Cellucid writes, `isHexColor`, `hexOfBytes`, `hexOfRgb01`, `bytesOfHex`, `rgb01OfHex`): sessions, exports, color inputs, Scanpy's `uns['<key>_colors']`, plot colors. Do not parse or format `#rrggbb` anywhere else. |
| `byte-text.js` | Bytes written as text and read back (`hexOfByteArray`, `randomHex`, `randomBytes`, `base64OfBytes`, `bytesOfBase64`, `base64UrlOfBytes`, `bytesOfBase64Url`): digests, sign-in states, PKCE, share ids, pictures, kept stores, cell records, GitHub contents. Do not call `btoa`/`atob` or write a byte as two hex digits anywhere else (`tests/byte-text-contract.test.mjs`). |
| `sha256.js` | The one SHA-256 (`sha256Hex`, `sha256Bytes`, `sha256HexWithoutWebCrypto`): WebCrypto where there is one, the same digest in script on a plain-HTTP origin (a LAN address), where `crypto.subtle` is absent. Nothing else calls `crypto.subtle.digest`. |
| `opaque-id.js` | A random v4 UUID in or out of a secure context (`createOpaqueId`): keyframes, saved queries, history and session ids, reader requests. |
| `fnv1a.js` | FNV-1a over a string's UTF-16 code units (`fnv1a32`): a quick hash of text, the same on every engine (string tables, retry spreads, figure seeds, pull-request branch names); not a digest. |
| `loopback.js` | Whether a host is this machine, in its two senses: a loopback host a browser trusts over plain HTTP (`isSecureContextLoopbackHost`: `localhost`, `*.localhost`, 127.0.0.0/8, `::1`; where a secret may go over http: `ALLOWED_ORIGINS`, a local relay) and this machine (`isLoopbackHostname`, `isLoopbackUrl`: those or `0.0.0.0`; served stores, the address box, the Share dialog, kept parts). |
| `origin-allowlist.js` | A Worker's exact `ALLOWED_ORIGINS` list (`parseOriginAllowlist`: https, or http on `isSecureContextLoopbackHost`); the community-annotation Worker imports it, the agent relay's copy (`relay/http.js`) is held to it by test. |
| `debounce.js` | Run something once calls stop coming for a while (`debounce(fn, waitMs)`, with `cancel`, `flush`, `pending`; a wait that may depend on the call): a search box, a preview redrawn, a wheel gesture's end, a hint after a dwell, idle workers retired, a journal closed once quiet. Never `clearTimeout(t); t = setTimeout(...)` by hand (`tests/one-implementation-contract.test.mjs`); work coalesced to one run after the first ask is not a debounce. |
| `deadline.js`, `yield-macrotask.js`, `person-wait.js` | Timers released on settle; the next macrotask (`onNextMacrotask`, `yieldToMacrotask`: a burst joining one plan, a long loop yielding, a gesture told from the next; never `setTimeout(…, 0)` or a channel of your own); waits on the person. |
| `startup-sequence.js` | The start's one order: the welcome first; Continue, a sample view's notices and an opening's question once it is closed. |
| `indexed-db-store.js`, `indexed-db-database.js` | The per-viewer IndexedDB records: one store as key-value (local file handles, decoder decisions), several in one transaction (the history's saved states). |
| `debug.js` | The shared debug logger (`localStorage.CELLUCID_DEBUG`). |
| `web-storage.js` | The one way to `localStorage` / `sessionStorage` (`webStorage(name)`: the store, or null where the browser keeps nothing for the site; `webStorageKeeps()`; `STORAGE_NOT_KEPT`). Never read the stores directly: their very read throws where site data is blocked (`tests/web-storage-contract.test.mjs`). |
| `machine.js` | The machine as plans read it: every rate measured of the machine or the link that a plan weighs (the link the reader plans on, the decoding rate, the order time, the kept-read rate, the index pass rates, the opening cost, the cores) is read with `measureOf` under its name, so a test or a benchmark holds it (`holdMachine`) on the page and in every worker. A new measured rate that feeds a plan gets a name here, never a pin of its own. |
| `theme-manager.js`, `style-manager.js` | Theme and design-token access. |
| `key-ownership.js` | Who a key press belongs to (`isPageKey`, `isTextEntry`, `isInKeyKeepingWidget`): every page-wide key listener (shortcuts, camera keys, Alt, Escape, undo) asks here; a text field, a dropdown, a menu, a list or a dialog keeps its keys, every other control leaves them to the page. Do not test `tagName` for typing anywhere else. |
| `reduced-motion.js` | The person's reduced-motion preference, the one reader of `prefers-reduced-motion` in script (`prefersReducedMotion`, `onReducedMotionChange`): every mover drawn by script asks here (camera path, tour, viewer fades and camera glide, backdrop looks, highlight pulse, smoke, the velocity overlay's still picture). CSS motion is stopped in `assets/css/base/_accessibility.css`. |

`../workers/` holds `worker-script.js` (where each worker starts from: its
source on a local server, its generated bundle in `assets/workers/`
elsewhere; and what a thread hands every worker it starts, `handToWorkers`) and `idle-retirement.js` (the one idle-lifetime rule of the
worker pools).

Other utility folders exist today (`app/utils/`, `app/analysis/shared/`);
their merge into this folder is stage 1 of the reorganization plan
(`cellucid-private/plans/audit-2026-10-28/code-organisation.md` §B).

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/27_decisions_memory_model.md`. Update them in the same change as the code.
