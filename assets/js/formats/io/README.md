# `formats/io/`: bytes, requests, the link, decoding

Every byte any reader reads comes through here. No module here knows what a
file holds; the module headers are long and exact, read them before editing.

## The path of one read

```
format reader (hdf5/, zarr/, rds/ …)
  └─ byte-reader.js   createByteReader: batches the reads of one task, plans
     │                them (merge gaps priced by the link: planMergeGap),
     │                splits large ones (requestPieceBytes), caps concurrency,
     │                keeps metadata blocks and merged-gap surplus a while
     ├─ own memory  →  kept-parts.js (this machine's disk, earlier visits)
     │              →  range-cache.js (the page's memory of other readers' bytes)
     └─ byte-source.js  blobByteSource (local File) | httpByteSource (Range
                        requests through fetchOnce, the one place a request to
                        a web host is sent) | bytesByteSource (memory)
                        └─ host-fetch.js routedFetch: a notebook kernel's bytes
                           over messages instead of the network
link.js     LinkMeter, measured from every request: round trip (latencyMs),
            round trip under load (loadedLatencyMs, loadedRoundTripMs),
            requests a host completes under load (loadedRequestMs), bandwidth
            (bytesPerMs), concurrency from the protocol; mergeGapBytes,
            maxRequestBytes, roundTripBytes, readsAhead follow from them
hosts.js    per-origin knowledge shared by every request: answer time,
            deliveries (stall detection), rate-limit budgets (admit/learn)
```

Decoding: `decode-pool.js` sends chunks to `decode-worker.js` on other cores
(small chunks travel together; background tasks wait); `decoder-choice.js`
picks a decoder per codec family by measuring them on the pool, kept by
`decoder-memory.js`; `inflate.js` (native `DecompressionStream` or fflate),
`wasm-codecs.js` (zstd, lz4, c-blosc in `assets/wasm/codecs.wasm`),
`shuffle.js`, `lz-match.js`, `byte-order.js`.

## Modules

| Module | Owns |
| --- | --- |
| `byte-reader.js` | Planning reads into requests; the only caller of a byte source. |
| `byte-source.js` | Where a file's bytes come from; `REMOTE_POLICY` / `LOCAL_POLICY` priors; retry and transient-failure rules; `fetchOnce`; a host failing on its side said as that (`isHostSideStatus`, `hostFaultSentence`). |
| `link.js` | The measured link and everything derived from it (see header). |
| `hosts.js` | What this realm knows of each web host (by origin), shared across readers and tabs (`BroadcastChannel`). |
| `mirrors.js`, `s3.js` | Other addresses of the same bytes (public S3 mirrors). |
| `read-witness.js` | What was read, as checksums: when a host's validator moves, the bytes decide whether the file changed (a redeployed site gives every file new validators although its bytes are the same). Used by `byte-source.js` and `zarr/stores/http.js`. |
| `kept-parts.js` | Bytes of remote files kept in the origin-private file system across visits, as journals filed under the file's identity and size; checked by `page-checks.js`, written through `sync-access.js`. Storage itself is `data/anndata/transcode/space.js`. |
| `range-cache.js` | Worker side of the page's range cache (`data/byte-range-cache.js` is the page side). |
| `activity.js` | `ReadActivity`: what one operation read (requests, bytes, chunks), for progress and the read activity log. |
| `decode-pool.js`, `decode-worker.js`, `decoded-budget.js` | Decoding off the reader thread; one byte budget for decoded chunks of a store. |
| `decoder-choice.js`, `decoder-memory.js` | Measured decoder choice per family, kept in IndexedDB. |
| `inflate.js`, `wasm-codecs.js`, `shuffle.js`, `lz-match.js`, `byte-order.js` | Codecs and byte-level primitives. |
| `deflate-seek.js` | Random access into an unindexed DEFLATE stream (rapidgzip technique). Today imported only by `tests/text-matrix-stream-contract.test.mjs`; see the tidiness findings. |
| `host-fetch.js` | Requests to a notebook kernel through the widget's frame. |

## Link vocabulary

"Latency" in a name and "round trip" in prose are the same quantity.

| Name (`link.js`) | What it is | Used for |
| --- | --- | --- |
| `latencyMs` | the shortest recent round trip (windowed minimum) | shaping requests (merge gaps, request size) |
| `loadedLatencyMs`, `loadedRoundTripMs(link)` | a request's time under load less its transfer (median), and the price function that takes the larger of it and `latencyMs` | pricing reads (gene sample, Genes read for, exports, progressive first view) |
| `loadedRequestMs` | time between completions with every slot busy, less transfer | what one more request costs when a read is request-bound |
| `requestCostMs` | the larger of the host's request budget interval and `loadedRequestMs` | the floor of a request's price |
| `requestMs` | the larger of `latencyMs / shapingConcurrency` and `requestCostMs` | one more request of a plan (`mergeGapBytes`); `byte-reader.js` `planMergeGap` and `companionsOf` compute the same expression per concurrency themselves |
| `bytesPerMs`, `roundTripBytes` | bandwidth, and bandwidth × round trip | transfer time; a request's price in bytes |
| `pricingBytesPerMs` | the bandwidth gaps are priced at: the measured one, twice it while requests wait for a slot | `planMergeGap`, coalescing to the link |
| `roundTripBytesOf(link)` | `roundTripBytes`, else merge gap × `shapingConcurrency` (never the stream count) | the one rule every read price uses (`sparse-column-index.js`, `hdf5/chunk-index.js`, `data/anndata/matrix-access.js`) |

## Invariants

- A plan fetches a gap only when it saves time under the link as measured
  now; plans never merge across bytes already kept (`kept-parts.js`) or held.
- Requests in flight are registered by their bytes: a later read joins the
  request carrying its bytes instead of asking again (`byte-reader.js`
  `inFlight`).
- Until a link is measured, the source's prior (`ReadPolicy`) stands: a local
  file is a disk, a web host is nothing.
- Prices of reads use the round trip **under load** (`loadedRoundTripMs`);
  request shaping uses the **shortest** round trip.
- Only a file whose identity names a version keeps parts or range-cache
  entries (`data/sources/identity.js`); signature and token query parameters
  are never part of an identity (`data/sources/link-credentials.js`).

## Tests

`tests/formats-io-contract` (byte reader, sources, link), `tests/host-*`,
`tests/http-request-resilience-contract`, `tests/kept-parts-*`,
`tests/formats-decode-pool.test.mjs`, `tests/codec-layer-contract`,
`tests/wasm-codecs-contract.test.mjs`; find others with
`grep -l "formats/io/<module>" tests/*.test.mjs`.

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/21_decisions_decoders_and_codecs.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/22_decisions_link_model_and_request_planning.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/27_decisions_memory_model.md`. Update them in the same change as the code.
