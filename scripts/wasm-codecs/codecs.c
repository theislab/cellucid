/*
 * The exports of assets/wasm/codecs.wasm: Zstandard frames, LZ4 blocks,
 * Blosc 1 frames and bitshuffle's bit transpose, decoded by the upstream
 * libraries (zstd 1.5.6, lz4 1.10.0, c-blosc 1.21.6 with its zlib 1.3.1 and
 * bitshuffle), built by scripts/build-wasm-codecs.mjs. The JavaScript side is
 * assets/js/formats/io/wasm-codecs.js.
 *
 * A call decodes from one region of the module's memory into another, both
 * set out by codecs_buffers(): the input first, the output after it. Every
 * decoder writes no more than the output size it is given, so the size a
 * format declares bounds what a chunk can decode to. A decoder returns the
 * bytes it wrote, or a negative code (CODECS_* below; for zstd, minus its
 * ZSTD_ErrorCode). A Zstandard stream too long to hold whole is decoded
 * piece by piece in an instance of its own (codecs_zstd_stream_*).
 */

#include <stddef.h>
#include <stdint.h>

#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include "zstd_errors.h"
#include "lz4.h"
#include "blosc.h"
#include "zlib.h"
#include "bitshuffle-generic.h"
#include "shuffle.h"

#define EXPORT(name) __attribute__((export_name(#name)))

uintptr_t heap_mark(void);
void heap_release(uintptr_t mark);
void *malloc(size_t size);

/* The size codecs_zstd_content_size gives for frames that do not state it. */
#define CODECS_UNKNOWN_SIZE (-1.0)
/* Errors of the codecs other than zstd. */
#define CODECS_NO_MEMORY (-1)
#define CODECS_CORRUPT (-2)
#define CODECS_WRONG_SIZE (-3)

/* The heap's top before the first call's buffers: each call's buffers start here. */
static uintptr_t kept = 0;
/* Where the current call's output lies. */
static uintptr_t output_at = 0;

/*
 * Set out a call's buffers: `input` bytes, then `output` bytes. Returns the
 * input's address (the output's is codecs_output()), or 0 when the memory
 * cannot grow to hold them. The previous call's buffers are given up.
 */

EXPORT(codecs_buffers) uintptr_t codecs_buffers(size_t input, size_t output) {
  if (kept == 0) kept = heap_mark();
  heap_release(kept);
  uint8_t *in = malloc(input);
  uint8_t *out = in == NULL ? NULL : malloc(output);
  if (out == NULL) {
    heap_release(kept);
    return 0;
  }
  output_at = (uintptr_t)out;
  return (uintptr_t)in;
}

EXPORT(codecs_output) uintptr_t codecs_output(void) { return output_at; }

/*
 * The decoded size the Zstandard frames of src state, summed over every
 * frame (skippable frames add nothing), or CODECS_UNKNOWN_SIZE when a frame
 * does not state it, or -2 when src is not Zstandard frames.
 */
EXPORT(codecs_zstd_content_size) double codecs_zstd_content_size(const uint8_t *src, size_t src_size) {
  unsigned long long size = ZSTD_findDecompressedSize(src, src_size);
  if (size == ZSTD_CONTENTSIZE_UNKNOWN) return CODECS_UNKNOWN_SIZE;
  if (size == ZSTD_CONTENTSIZE_ERROR) return CODECS_CORRUPT;
  return (double)size;
}

/* Every Zstandard frame of src, one after another, into dst (at most dst_capacity bytes). */
EXPORT(codecs_zstd) int32_t codecs_zstd(const uint8_t *src, size_t src_size, uint8_t *dst, size_t dst_capacity) {
  uintptr_t mark = heap_mark();
  ZSTD_DCtx *context = ZSTD_createDCtx();
  if (context == NULL) return CODECS_NO_MEMORY;
  size_t written = ZSTD_decompressDCtx(context, dst, dst_capacity, src, src_size);
  heap_release(mark);
  if (ZSTD_isError(written)) return -(int32_t)ZSTD_getErrorCode(written);
  return (int32_t)written;
}

/*
 * A Zstandard stream decoded piece by piece (R's saveRDS(compress = "zstd"),
 * a stream too long to hold whole): one stream per instance, begun before
 * anything else is asked of it, so its context, its fixed input and output
 * buffers and the window zstd allocates as frames need it all lie in a heap
 * no call's buffers release. Each step decodes input[from, to) into the
 * output buffer and says how much input it consumed.
 */
static ZSTD_DCtx *stream = NULL;
static uint8_t *stream_input = NULL;
static uint8_t *stream_output = NULL;
static size_t stream_consumed = 0;
static size_t stream_hint = 1;

EXPORT(codecs_zstd_stream_begin) int32_t codecs_zstd_stream_begin(void) {
  if (stream != NULL || kept != 0) return CODECS_CORRUPT;
  stream = ZSTD_createDCtx();
  stream_input = malloc(ZSTD_DStreamInSize());
  stream_output = malloc(ZSTD_DStreamOutSize());
  if (stream == NULL || stream_input == NULL || stream_output == NULL) return CODECS_NO_MEMORY;
  return 0;
}

EXPORT(codecs_zstd_stream_input) uintptr_t codecs_zstd_stream_input(void) { return (uintptr_t)stream_input; }
EXPORT(codecs_zstd_stream_input_size) uint32_t codecs_zstd_stream_input_size(void) { return (uint32_t)ZSTD_DStreamInSize(); }
EXPORT(codecs_zstd_stream_output) uintptr_t codecs_zstd_stream_output(void) { return (uintptr_t)stream_output; }
EXPORT(codecs_zstd_stream_output_size) uint32_t codecs_zstd_stream_output_size(void) { return (uint32_t)ZSTD_DStreamOutSize(); }
EXPORT(codecs_zstd_stream_consumed) uint32_t codecs_zstd_stream_consumed(void) { return (uint32_t)stream_consumed; }
/* Whether the last step ended a frame exactly (zstd's hint 0): a stream may end there. */
EXPORT(codecs_zstd_stream_ended) int32_t codecs_zstd_stream_ended(void) { return stream_hint == 0; }

EXPORT(codecs_zstd_stream_step) int32_t codecs_zstd_stream_step(size_t from, size_t to) {
  if (stream == NULL || from > to || to > ZSTD_DStreamInSize()) return CODECS_CORRUPT;
  ZSTD_inBuffer in = { stream_input, to, from };
  ZSTD_outBuffer out = { stream_output, ZSTD_DStreamOutSize(), 0 };
  size_t hint = ZSTD_decompressStream(stream, &out, &in);
  if (ZSTD_isError(hint)) return -(int32_t)ZSTD_getErrorCode(hint);
  stream_consumed = in.pos;
  stream_hint = hint;
  return (int32_t)out.pos;
}

/* One LZ4 block into dst, which it must fill exactly. */
EXPORT(codecs_lz4_block) int32_t codecs_lz4_block(const uint8_t *src, size_t src_size, uint8_t *dst, size_t dst_size) {
  int written = LZ4_decompress_safe((const char *)src, (char *)dst, (int)src_size, (int)dst_size);
  if (written < 0) return CODECS_CORRUPT;
  return written == (int)dst_size ? written : CODECS_WRONG_SIZE;
}

/*
 * Blosc frames whose streams are zlib-compressed are inflated outside this
 * module, by the decoder the page measured fastest for DEFLATE (the
 * platform's stream or fflate: formats/io/decoder-choice.js), while c-blosc
 * still reads the frame: zlib's `uncompress` here records each stream
 * c-blosc asks it to inflate (where it lies in the frame, its length, where
 * its bytes go in the frame's output, how many). The caller inflates them
 * there and un-shuffles the blocks (codecs_blosc_unshuffle). No zlib code is
 * in the module.
 */
static int zlib_recording = 0;
static const uint8_t *zlib_frame = NULL;
static const uint8_t *zlib_output = NULL;
static uint32_t *zlib_table = NULL;
static size_t zlib_count = 0;
static size_t zlib_capacity = 0;

int uncompress(Bytef *dest, uLongf *destLen, const Bytef *source, uLong sourceLen) {
  if (!zlib_recording) return Z_DATA_ERROR;
  if (zlib_count == zlib_capacity) return Z_MEM_ERROR;
  uint32_t *entry = zlib_table + 4 * zlib_count++;
  entry[0] = (uint32_t)(source - zlib_frame);
  entry[1] = (uint32_t)sourceLen;
  entry[2] = (uint32_t)(dest - zlib_output);
  entry[3] = (uint32_t)*destLen;
  return Z_OK;
}

/* The flag bits of a frame's header c-blosc 1 reads or refuses. */
#define BLOSC_DO_SHUFFLE 0x01
#define BLOSC_MEMCPYED_FLAG 0x02
#define BLOSC_DO_BITSHUFFLE 0x04
#define BLOSC_DO_DELTA 0x08

/*
 * Undo c-blosc2's delta filter over a decoded frame, in place (as
 * formats/zarr/codecs/blosc.js does): the first block is a running XOR of
 * words of the element size (8 bytes for other multiples of 8, bytes
 * otherwise), each later block is XORed with the first.
 */
static void undo_delta(uint8_t *output, size_t length, size_t blocksize, size_t typesize) {
  size_t word = (typesize == 1 || typesize == 2 || typesize == 4 || typesize == 8) ? typesize : (typesize % 8 == 0 ? 8 : 1);
  size_t first = blocksize < length ? blocksize : length;
  size_t whole = first - first % word;
  for (size_t at = word; at < whole; at++) output[at] ^= output[at - word];
  for (size_t start = blocksize; start < length; start += blocksize) {
    size_t size = blocksize < length - start ? blocksize : length - start;
    size_t end = start + size - size % word;
    for (size_t at = start; at < end; at++) output[at] ^= output[at - start];
  }
}

static size_t header_word(const uint8_t *src, size_t at) {
  return (size_t)src[at] | ((size_t)src[at + 1] << 8) | ((size_t)src[at + 2] << 16) | ((size_t)src[at + 3] << 24);
}

/*
 * One Blosc 1 frame into dst, which it must fill exactly. The frame is read
 * as c-blosc 1.21.6 reads its own format (version 2), with what the
 * JavaScript reader read besides: a version 1 frame, laid out alike, and
 * c-blosc2's delta flag (the delta is undone after c-blosc decodes the
 * frame without it). Both are set in the module's copy of the header only.
 */
static int32_t decode_blosc(uint8_t *src, size_t src_size, uint8_t *dst, size_t dst_size) {
  if (src_size < BLOSC_MIN_HEADER_LENGTH) return CODECS_CORRUPT;
  if (src[0] == 1) src[0] = BLOSC_VERSION_FORMAT;
  uint8_t flags = src[2];
  int delta = (flags & BLOSC_DO_DELTA) != 0 && (flags & BLOSC_MEMCPYED_FLAG) == 0;
  src[2] = (uint8_t)(flags & ~BLOSC_DO_DELTA);
  /* Recording reads where the streams lie, which shuffling does not move: no block is un-shuffled. */
  if (zlib_recording) src[2] = (uint8_t)(src[2] & ~(BLOSC_DO_SHUFFLE | BLOSC_DO_BITSHUFFLE));
  size_t declared = 0;
  if (blosc_cbuffer_validate(src, src_size, &declared) != 0) return CODECS_CORRUPT;
  if (declared != dst_size) return CODECS_WRONG_SIZE;
  uintptr_t mark = heap_mark();
  int written = blosc_decompress_ctx(src, dst, dst_size, 1);
  heap_release(mark);
  if (written < 0) return written == -1 ? CODECS_CORRUPT : written;
  if ((size_t)written != dst_size) return CODECS_WRONG_SIZE;
  if (delta && !zlib_recording) undo_delta(dst, dst_size, header_word(src, 8), src[3]);
  return written;
}

EXPORT(codecs_blosc) int32_t codecs_blosc(uint8_t *src, size_t src_size, uint8_t *dst, size_t dst_size) {
  return decode_blosc(src, src_size, dst, dst_size);
}

/*
 * A frame with zlib streams: c-blosc reads it, writing its stored (not
 * compressed) streams to dst where they go before un-shuffling, and every
 * stream it would inflate is recorded (codecs_blosc_zlib_streams: offset in
 * the frame, compressed length, offset in dst, inflated length; four words
 * each). Returns how many, or a negative code.
 */
EXPORT(codecs_blosc_zlib_record) int32_t codecs_blosc_zlib_record(uint8_t *src, size_t src_size, uint8_t *dst, size_t dst_size) {
  if (src_size < BLOSC_MIN_HEADER_LENGTH) return CODECS_CORRUPT;
  size_t blocksize = header_word(src, 8);
  if (blocksize == 0) return CODECS_CORRUPT;
  /* A block splits into at most 16 streams (one per byte of an element of up to 16 bytes). */
  size_t blocks = (dst_size + blocksize - 1) / blocksize;
  zlib_capacity = (blocks == 0 ? 1 : blocks) * 16;
  zlib_table = malloc(zlib_capacity * 4 * sizeof(uint32_t));
  if (zlib_table == NULL) return CODECS_NO_MEMORY;
  zlib_count = 0;
  zlib_frame = src;
  zlib_output = dst;
  zlib_recording = 1;
  int32_t result = decode_blosc(src, src_size, dst, dst_size);
  zlib_recording = 0;
  return result < 0 ? result : (int32_t)zlib_count;
}

EXPORT(codecs_blosc_zlib_streams) uintptr_t codecs_blosc_zlib_streams(void) { return (uintptr_t)zlib_table; }

/*
 * The rest of a frame's decoding once its streams are in place (`src`, the
 * bytes before un-shuffling): each block un-shuffled as c-blosc's blosc_d
 * does (byte shuffle for elements over 1 byte, bit shuffle for a block of
 * at least one element; the last block may be shorter), then the delta
 * undone. `header` is the frame's 16-byte header.
 */
EXPORT(codecs_blosc_unshuffle) int32_t codecs_blosc_unshuffle(const uint8_t *header, const uint8_t *src, uint8_t *dst, size_t size) {
  size_t typesize = header[3];
  size_t blocksize = header_word(header, 8);
  uint8_t flags = header[2];
  if (typesize == 0 || blocksize == 0) return CODECS_CORRUPT;
  uintptr_t mark = heap_mark();
  uint8_t *scratch = malloc(blocksize);
  if (scratch == NULL) return CODECS_NO_MEMORY;
  for (size_t start = 0; start < size; start += blocksize) {
    size_t block = blocksize < size - start ? blocksize : size - start;
    if ((flags & BLOSC_DO_SHUFFLE) && typesize > 1) {
      blosc_internal_unshuffle(typesize, block, src + start, dst + start);
    } else if ((flags & BLOSC_DO_BITSHUFFLE) && block >= typesize) {
      if (blosc_internal_bitunshuffle(typesize, block, src + start, dst + start, scratch) < 0) {
        heap_release(mark);
        return CODECS_CORRUPT;
      }
    } else {
      __builtin_memcpy(dst + start, src + start, block);
    }
  }
  heap_release(mark);
  if ((flags & BLOSC_DO_DELTA) && !(flags & BLOSC_MEMCPYED_FLAG)) undo_delta(dst, size, blocksize, typesize);
  return (int32_t)size;
}

static size_t read_be32(const uint8_t *at) {
  return ((size_t)at[0] << 24) | ((size_t)at[1] << 16) | ((size_t)at[2] << 8) | (size_t)at[3];
}

/*
 * One chunk through the HDF5 bitshuffle filter (32008, kiyo-masui/bitshuffle's
 * bshuf_h5filter.c, as hdf5plugin builds it), undone. `compression` is the
 * filter's fifth parameter: 0, the chunk is bit-transposed blocks of
 * `block_elems` elements (0: bitshuffle's default, 8 KiB of elements
 * rounded down to a multiple of 8, at least 128); 2 (LZ4) or 3 (zstd), the
 * chunk is an 8-byte big-endian decoded size and a 4-byte big-endian block
 * size in bytes, then each block as a 4-byte big-endian length and its LZ4
 * block or zstd frame. Either way the last block is the elements left
 * rounded down to a multiple of 8, and the last `elements % 8` are stored as
 * they are, after every block.
 */
EXPORT(codecs_bitshuffle_chunk) int32_t codecs_bitshuffle_chunk(const uint8_t *src, size_t src_size, uint8_t *dst, size_t dst_size,
                                                                size_t elem_size, size_t block_elems, int32_t compression) {
  if (elem_size == 0 || dst_size % elem_size != 0) return CODECS_CORRUPT;
  size_t at = 0;
  if (compression == 2 || compression == 3) {
    if (src_size < 12) return CODECS_CORRUPT;
    if (read_be32(src) != 0 || read_be32(src + 4) != dst_size) return CODECS_WRONG_SIZE;
    size_t block_bytes = read_be32(src + 8);
    if (block_bytes % elem_size != 0) return CODECS_CORRUPT;
    block_elems = block_bytes / elem_size;
    at = 12;
  } else if (compression == 0) {
    if (src_size != dst_size) return CODECS_WRONG_SIZE;
    if (block_elems == 0) {
      block_elems = (8192 / elem_size) / 8 * 8;
      if (block_elems < 128) block_elems = 128;
    }
  } else {
    return CODECS_CORRUPT;
  }
  if (block_elems == 0 || block_elems % 8 != 0) return CODECS_CORRUPT;
  size_t elements = dst_size / elem_size;
  uintptr_t mark = heap_mark();
  uint8_t *block = malloc(block_elems * elem_size);
  uint8_t *scratch = malloc(block_elems * elem_size);
  ZSTD_DCtx *zstd = compression == 3 ? ZSTD_createDCtx() : NULL;
  int32_t result = (block == NULL || scratch == NULL || (compression == 3 && zstd == NULL)) ? CODECS_NO_MEMORY : 0;
  size_t done = 0;
  while (result == 0 && done + 8 <= elements) {
    size_t n = elements - done < block_elems ? (elements - done) / 8 * 8 : block_elems;
    size_t bytes = n * elem_size;
    const uint8_t *transposed;
    if (compression == 0) {
      transposed = src + at;
      at += bytes;
    } else {
      if (src_size - at < 4) { result = CODECS_CORRUPT; break; }
      size_t stored = read_be32(src + at);
      at += 4;
      if (stored > src_size - at) { result = CODECS_CORRUPT; break; }
      size_t got;
      if (compression == 2) {
        int decoded = LZ4_decompress_safe((const char *)src + at, (char *)block, (int)stored, (int)bytes);
        got = decoded < 0 ? (size_t)-1 : (size_t)decoded;
      } else {
        got = ZSTD_decompressDCtx(zstd, block, bytes, src + at, stored);
        if (ZSTD_isError(got)) got = (size_t)-1;
      }
      if (got != bytes) { result = CODECS_CORRUPT; break; }
      at += stored;
      transposed = block;
    }
    if (blosc_internal_bshuf_untrans_bit_elem_scal(transposed, dst + done * elem_size, n, elem_size, scratch) < 0) result = CODECS_CORRUPT;
    done += n;
  }
  heap_release(mark);
  if (result != 0) return result;
  size_t left = (elements - done) * elem_size;
  if (src_size - at != left) return CODECS_CORRUPT;
  __builtin_memcpy(dst + done * elem_size, src + at, left);
  return (int32_t)dst_size;
}

/*
 * Bitshuffle's inverse bit transpose of `count` elements of `typesize`
 * bytes (count a multiple of 8): what the HDF5 bitshuffle filter (32008)
 * undoes in each block once it is decompressed. src and dst do not overlap.
 */
EXPORT(codecs_bitshuffle_untranspose) int32_t codecs_bitshuffle_untranspose(const uint8_t *src, uint8_t *dst, size_t count, size_t typesize) {
  if (count % 8 != 0 || typesize == 0) return CODECS_CORRUPT;
  uintptr_t mark = heap_mark();
  void *scratch = malloc(count * typesize);
  if (scratch == NULL) return CODECS_NO_MEMORY;
  int64_t done = blosc_internal_bshuf_untrans_bit_elem_scal(src, dst, count, typesize, scratch);
  heap_release(mark);
  return done < 0 ? CODECS_CORRUPT : (int32_t)(count * typesize);
}
