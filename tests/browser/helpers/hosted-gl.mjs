/**
 * The one cell of the CI matrix whose WebGL is too slow for GPU-heavy work at
 * full size: Firefox on GitHub's macOS runner, which draws through OpenGL on
 * the runner's paravirtual GPU. A 1024² fragment pass takes about a minute
 * there, where Metal on the same runner takes milliseconds and software GL on
 * Linux and Windows about a second, whatever Firefox's preferences say. A
 * spec that draws less there says so where it does; what it asserts of what
 * it draws is the same as on every other cell, pixels included.
 */
export function isHostedMacosFirefox(browserName) {
  return browserName === 'firefox' && process.platform === 'darwin' && process.env.CI === 'true';
}
