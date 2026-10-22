import { gzipSync } from 'node:zlib';

import { expect, test } from './helpers/test.mjs';

/**
 * `gzipDecompress` inflates once, natively, and checks only the constant-size
 * envelope itself. Rejecting trailing bytes, further members, corrupt CRCs and
 * a trailer ISIZE that disagrees with the real output is therefore each
 * engine's `DecompressionStream` contract, which this pins per engine.
 */
function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = value >>> 24;
}

function withIsize(bytes, value) {
  const forged = Uint8Array.from(bytes);
  writeUint32LE(forged, forged.byteLength - 4, value);
  return forged;
}

test('every engine rejects gzip inputs that are not one well-formed member', async ({ page }) => {
  const input = Buffer.from('single member '.repeat(100));
  const member = new Uint8Array(gzipSync(input));
  const empty = new Uint8Array(gzipSync(Buffer.alloc(0)));
  const concat = (...parts) => Uint8Array.from(Buffer.concat(parts));
  const badCrc = Uint8Array.from(member);
  badCrc[badCrc.byteLength - 8] ^= 1;
  const badFhcrc = concat(
    Uint8Array.of(0x1f, 0x8b, 8, 0x02, 0, 0, 0, 0, 0, 255, 0, 0),
    member.subarray(10),
  );
  const isize = new Uint8Array(4);
  writeUint32LE(isize, 0, input.byteLength);
  const bombBytes = 128 * 1024 * 1024;
  const cases = {
    trailingBytes: [concat(member, isize), input.byteLength],
    twoMembers: [concat(member, member), input.byteLength],
    emptyThenMember: [concat(empty, member), input.byteLength],
    badCrc: [badCrc, input.byteLength],
    badFhcrc: [badFhcrc, input.byteLength],
    truncated: [
      concat(member.subarray(0, member.byteLength - 12), member.subarray(member.byteLength - 8)),
      input.byteLength,
    ],
    forgedIsizeShort: [withIsize(member, input.byteLength - 1), input.byteLength - 1],
    forgedIsizeLong: [withIsize(member, input.byteLength + 1), input.byteLength + 1],
    forgedIsizeBomb: [
      withIsize(gzipSync(Buffer.alloc(bombBytes), { level: 1 }), 1024 * 1024),
      1024 * 1024,
    ],
  };
  const payload = Object.fromEntries(
    Object.entries(cases).map(([name, [bytes, max]]) => [
      name,
      [Buffer.from(bytes).toString('base64'), max],
    ]),
  );

  await page.goto('/robots.txt');
  const outcome = await page.evaluate(async ({ payload, good, goodBytes }) => {
    const { gzipDecompress } = await import(
      '/assets/js/app/session/codecs/gzip.js'
    );
    const decode = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const restored = await gzipDecompress(decode(good), {
      maxOutputBytes: goodBytes,
      signal: null,
    });
    const results = { good: restored.byteLength };
    for (const [name, [base64, maxOutputBytes]] of Object.entries(payload)) {
      try {
        await gzipDecompress(decode(base64), { maxOutputBytes, signal: null });
        results[name] = 'accepted';
      } catch (error) {
        results[name] = { message: String(error?.message ?? error) };
      }
    }
    return results;
  }, {
    payload,
    good: Buffer.from(member).toString('base64'),
    goodBytes: input.byteLength,
  });

  expect(outcome.good).toBe(input.byteLength);
  for (const name of Object.keys(cases)) {
    expect(outcome[name], name).not.toBe('accepted');
    expect(outcome[name].message, name).toMatch(
      /not exactly one well-formed member|Decompressed data (exceeds limit|produced)/,
    );
  }
  expect(outcome.forgedIsizeBomb.message).toMatch(/Decompressed data exceeds limit/);
});
