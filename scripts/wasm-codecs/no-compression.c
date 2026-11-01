/*
 * The compressors c-blosc names: this build decodes only, so they are left
 * out of it (zstd's lib/compress, lz4hc.c, zlib). c-blosc's
 * compression functions that call them are never exported and the linker
 * drops them, these with them; should one ever be reached, it traps.
 */

#include <stddef.h>

int ZSTD_maxCLevel(void) { __builtin_trap(); }
size_t ZSTD_compress(void *dst, size_t dstCapacity, const void *src, size_t srcSize, int level) {
  (void)dst; (void)dstCapacity; (void)src; (void)srcSize; (void)level;
  __builtin_trap();
}
int compress2(unsigned char *dst, unsigned long *dstLen, const unsigned char *src, unsigned long srcLen, int level) {
  (void)dst; (void)dstLen; (void)src; (void)srcLen; (void)level;
  __builtin_trap();
}
int LZ4_compress_HC(const char *src, char *dst, int srcSize, int dstCapacity, int level) {
  (void)src; (void)dst; (void)srcSize; (void)dstCapacity; (void)level;
  __builtin_trap();
}
