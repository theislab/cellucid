/**
 * The one cell of the CI matrix whose WebGL is not a fair test of pixels or of
 * GPU-heavy work: Firefox on GitHub's macOS runner, which draws through OpenGL
 * on the runner's paravirtual GPU. Measured with a 1024² fragment pass
 * (run 39646038155): 55 to 69 s a pass, where Metal on the same runner takes
 * 22 ms and software GL on Linux and Windows 0.3 to 1.8 s, whatever Firefox's
 * preferences say. And the same bytes in two GPU objects have come out a few
 * pixels apart there, with the cameras asserted equal (measured 2026-10-21:
 * 3 of 1.4 million pixels off by 1 after a kept view's stores were rebuilt
 * from identical bytes, while the same bytes drawn twice from the same
 * objects were identical every time; 13 of 921,600 off by at most 2,
 * `snapshot-compact-lod-parity`, nightly run 41382954122).
 *
 * What holds there, exactly as on every cell: every input to a draw that a
 * spec asserts (cameras, draw order, the bytes of the stores, cells drawn)
 * and, where a spec records it, everything the compared frames submitted to
 * the GPU: each draw's program, ranges, viewport and uniforms
 * (`gl-submissions.mjs`).
 *
 * What a spec gives up there, it says, and each such check runs in full on
 * Firefox on Linux and Windows, and on Chromium and WebKit on macOS:
 * - Pixels of two GPU objects holding the same bytes are compared with a
 *   bound, not for equality: no more than one lit pixel in a thousand may
 *   differ (`pixelParityVerdict`, `lod-rank-order-resize`,
 *   `segmented-point-stores`). The bound still fails on what moves whole
 *   points: a wrong order, color or camera, cells missing or drawn twice.
 *   A context the browser restores holds every store and texture in a new
 *   GPU object (`graphics-context-restore`), and is compared so too.
 *   It cannot show a difference of fewer pixels than that which only this
 *   renderer would draw; the submissions above are what stands against one.
 * - The figure export's point pass drawn in a worker and on the page is not
 *   compared pixel for pixel (two GL contexts; the contexts are compared).
 * - `segmented-point-stores` draws 12,000 points, not 60,000 (which took
 *   over ten minutes a test): three segments, so full detail and the reduced
 *   level still cross a segment boundary.
 *
 * Not established: that those few pixels are the renderer's rounding and
 * nothing else. They were measured on the hosted cell, which no machine of
 * ours reproduces; a spec that fails there attaches both frames' submissions
 * so the next reading starts from what was drawn.
 *
 * No other cell has such a treatment. Two pixels that differed on hosted
 * Windows Firefox (`segmented-point-stores`, nightly runs 41269083996 and
 * 42180511574) were read from two different kinds of frame, the first after
 * a change on one side and a later pulse frame on the other
 * (`gl-submissions.mjs`): the spec now reads steady frames and asserts what
 * they submitted, and compares their pixels for equality there too.
 */
export function isHostedMacosFirefox(browserName) {
  return browserName === 'firefox' && process.platform === 'darwin' && process.env.CI === 'true';
}
